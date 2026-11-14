/**
 * Kitchen Drawers fork: export one drawer's print set on request from the
 * kitchen app. Lives in the shell because it composes bin-designer storage,
 * the layout store and the whole-layout export, which a feature may not mix.
 *
 * Nothing new is generated here: the upstream whole-layout export does the
 * work, and its "also POST exports to a URL" setting carries the ZIP to the
 * kitchen app. This file only prepares the layout and points that setting at
 * the right address for the length of one export.
 */
import { isFractional, STAGING_ID } from '@/core/constants';
import { batch, commandBus, createCommand } from '@/core/cqrs';
import { isOk } from '@/core/result';
import { useLayoutStore } from '@/core/store/layout';
import { useSettingsStore } from '@/core/store/settings';
import type { Bin, Layout } from '@/core/types';
import { saveDesign } from '@/features/bin-designer/storage/DesignerStorage';
import {
  registryEdgeFields,
  registryHeightFields,
  registryKnifeRestFields,
  registryOverhangFields,
  registrySlantFields,
  registrySplitFields,
  upsertRegistryEntry,
} from '@/features/bin-designer/store/customBinRegistry';
import { defaultsForNewDesign } from '@/features/bin-designer/store/helpers';
import { hasDetachableFeet } from '@/features/bin-designer/types/base';
import { withSyncedLidHeight } from '@/features/bin-designer/utils/lidHeightUnits';
import type { KdPrintSetResult } from '@/shared/kdEmbed/bridge';
import type { KdExportPrintSetMessage } from '@/shared/kdEmbed/protocol';
import type { BinParams, ExportFileFormat, ExportFileNameConfig } from '@/shared/types/bin';
import { computeMatchedFootLattice, edgeForPosition } from '@/shared/utils/fractionalEdge';

type ExportLayout = (
  format: ExportFileFormat,
  zipBaseName: string,
  fileNameConfig: ExportFileNameConfig
) => Promise<boolean>;

/** Bins on the grid that have no bin design yet, grouped so same-sized bins share one design. */
export function kdGroupUnlinkedBins(layout: Layout): Bin[][] {
  const groups = new Map<string, Bin[]>();
  for (const bin of layout.bins) {
    if (bin.layerId === STAGING_ID || bin.linkedDesignId !== undefined) continue;
    // A half-unit bin's design depends on where it sits, so it never shares.
    const fractional = isFractional(bin.width) || isFractional(bin.depth);
    const key = fractional ? `bin:${bin.id}` : `${bin.width}x${bin.depth}x${bin.height}`;
    groups.set(key, [...(groups.get(key) ?? []), bin]);
  }
  return [...groups.values()];
}

/** The default bin a plain layout bin stands for: the user's defaults at this bin's size. */
export function kdDefaultParamsFor(bins: readonly Bin[], layout: Layout): BinParams {
  const defaults = defaultsForNewDesign();
  const first = bins[0];
  const lattice = computeMatchedFootLattice(
    {
      width: first.width,
      depth: first.depth,
      halfSockets: defaults.base.halfSockets,
      detachableFeet: hasDetachableFeet(defaults.base),
    },
    layout.drawer,
    bins.map((bin) => ({ x: bin.x, y: bin.y }))
  );
  return withSyncedLidHeight({
    ...defaults,
    base: { ...defaults.base, ...lattice },
    width: first.width,
    depth: first.depth,
    height: first.height,
    ...(isFractional(first.width)
      ? {
          fractionalEdgeX: edgeForPosition(
            first.x,
            layout.drawer.width,
            layout.drawer.fractionalEdgeX
          ),
        }
      : {}),
    ...(isFractional(first.depth)
      ? {
          fractionalEdgeY: edgeForPosition(
            first.y,
            layout.drawer.depth,
            layout.drawer.fractionalEdgeY
          ),
        }
      : {}),
    fractionalEdgeManualX: false,
    fractionalEdgeManualY: false,
    gridUnitMm: layout.gridUnitMm,
    heightUnitMm: layout.heightUnitMm,
  });
}

/**
 * Give every plain bin a default bin design, because only bins with a design
 * have geometry to export. Returns how many bins were linked.
 */
export async function kdAutoLinkBins(): Promise<number> {
  const layout = useLayoutStore.getState().layout;
  let linked = 0;
  for (const bins of kdGroupUnlinkedBins(layout)) {
    const params = kdDefaultParamsFor(bins, layout);
    const saved = await saveDesign({
      name: `Bin ${params.width}×${params.depth}×${params.height}u`,
      params,
      thumbnail: null,
      exportFileNameConfig: null,
    });
    if (!isOk(saved)) continue;
    const design = saved.value;
    upsertRegistryEntry({
      id: design.id,
      name: design.name,
      width: params.width,
      depth: params.depth,
      height: params.height,
      ...registryEdgeFields(params),
      ...registryHeightFields(params),
      ...registryOverhangFields(params),
      ...registrySplitFields(params),
      ...registrySlantFields(params),
      ...registryKnifeRestFields(params),
      updatedAt: design.updatedAt,
    });
    batch(() => {
      for (const bin of bins) {
        const result = commandBus.dispatch(
          createCommand('bin.update', { id: bin.id, updates: { linkedDesignId: design.id } })
        );
        if (isOk(result)) linked += 1;
      }
    });
  }
  return linked;
}

/** Run one print-set export for the kitchen app. */
export async function kdExportPrintSet(
  message: KdExportPrintSetMessage,
  exportLayout: ExportLayout
): Promise<KdPrintSetResult> {
  const linkedBins = await kdAutoLinkBins();

  const layout = useLayoutStore.getState().layout;
  const bedDepth = layout.printBedDepth ?? layout.printBedSize;
  if (layout.printBedSize !== message.bedMm.w || bedDepth !== message.bedMm.d) {
    commandBus.dispatch(
      createCommand('layout.setPrintBedSize', { size: message.bedMm.w, depth: message.bedMm.d })
    );
  }

  const settings = useSettingsStore.getState();
  const before = settings.settings;
  // The upload is queued with the settings in force when the export finishes,
  // so they only need to hold for the length of the call.
  settings.updateSettings({
    exportUrlEnabled: true,
    exportUrl: message.uploadUrl,
    exportUrlHeaderName: '',
    exportUrlHeaderValue: '',
  });
  try {
    const ok = await exportLayout(message.format, message.baseName, {
      style: 'descriptive',
      customName: '',
      format: message.format,
    });
    return ok
      ? { ok: true, linkedBins }
      : { ok: false, linkedBins, reason: 'The editor had nothing it could export.' };
  } finally {
    useSettingsStore.getState().updateSettings({
      exportUrlEnabled: before.exportUrlEnabled,
      exportUrl: before.exportUrl,
      exportUrlHeaderName: before.exportUrlHeaderName,
      exportUrlHeaderValue: before.exportUrlHeaderValue,
    });
  }
}
