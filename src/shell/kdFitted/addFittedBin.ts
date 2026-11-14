/**
 * Kitchen Drawers fork: make a fitted bin for a catalog item on request from
 * the kitchen app. Saves a bin design with a pocket for the item, then adds a
 * bin linked to it in the first free spot of the drawer (or the stash if the
 * drawer is full). The bin carries the item's minimum footprint, which the
 * layout solver honors.
 */
import { STAGING_ID } from '@/core/constants';
import { commandBus, createCommand } from '@/core/cqrs';
import { isOk } from '@/core/result';
import { useLayoutStore, useSelectionStore } from '@/core/store';
import type { Bin, GridUnits, HeightUnits, LayerId, Layout } from '@/core/types';
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
import { withSyncedLidHeight } from '@/features/bin-designer/utils/lidHeightUnits';
import type { KdFittedBinResult } from '@/shared/kdEmbed/bridge';
import type { KdAddFittedBinMessage } from '@/shared/kdEmbed/protocol';
import { KD_MIN_D_KEY, KD_MIN_W_KEY } from '@/shared/kdSolver/editor';
import { canPlaceBin } from '@/shared/utils/validation';
import { kdPlanFittedBin } from './fittedPlan';

/** Which catalog item a bin was made for; read by the kitchen app. */
export const KD_ITEM_ID_KEY = 'kd.itemId';

/** First free spot for a bin of this size, scanning front to back, left to right. */
export function kdFindFreeSpot(
  layout: Layout,
  layerId: LayerId,
  size: { w: number; d: number; h: number }
): { x: number; y: number } | null {
  for (let y = 0; y + size.d <= layout.drawer.depth; y++) {
    for (let x = 0; x + size.w <= layout.drawer.width; x++) {
      const fits = canPlaceBin(
        {
          x: x as GridUnits,
          y: y as GridUnits,
          width: size.w as GridUnits,
          depth: size.d as GridUnits,
          height: size.h as HeightUnits,
        },
        layerId,
        layout
      ).valid;
      if (fits) return { x, y };
    }
  }
  return null;
}

export async function kdAddFittedBin(message: KdAddFittedBinMessage): Promise<KdFittedBinResult> {
  const layout = useLayoutStore.getState().layout;
  const plan = kdPlanFittedBin(message, defaultsForNewDesign(), {
    gridUnitMm: layout.gridUnitMm,
    heightUnitMm: layout.heightUnitMm,
    drawerHeightUnits: layout.drawer.height,
  });
  if (typeof plan === 'string') return { ok: false, reason: plan };

  const params = withSyncedLidHeight(plan.params);
  const saved = await saveDesign({
    name: `Holder: ${message.item.name}`.slice(0, 64),
    params,
    thumbnail: null,
    exportFileNameConfig: null,
  });
  if (!isOk(saved))
    return { ok: false, reason: 'The bin design could not be saved in this browser.' };
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

  const selection = useSelectionStore.getState();
  const layer = layout.layers.find((l) => l.id === selection.activeLayerId) ?? layout.layers[0];
  const category =
    layout.categories.find((c) => c.id === selection.activeCategoryId) ?? layout.categories[0];
  const spot = kdFindFreeSpot(layout, layer.id, plan.units);
  const bin: Omit<Bin, 'id'> = {
    layerId: spot ? layer.id : STAGING_ID,
    x: (spot?.x ?? 0) as GridUnits,
    y: (spot?.y ?? 0) as GridUnits,
    width: plan.units.w as GridUnits,
    depth: plan.units.d as GridUnits,
    height: plan.units.h as HeightUnits,
    category: category.id,
    label: message.item.name.slice(0, 24),
    notes: '',
    linkedDesignId: design.id,
    items: [{ id: message.item.id.slice(0, 64), name: message.item.name.slice(0, 48), qty: 1 }],
    customProperties: {
      [KD_MIN_W_KEY]: String(plan.units.w),
      [KD_MIN_D_KEY]: String(plan.units.d),
      [KD_ITEM_ID_KEY]: message.item.id,
    },
  };
  const added = commandBus.dispatch(createCommand('bin.add', bin));
  if (!isOk(added)) return { ok: false, reason: 'The bin could not be added to this drawer.' };

  const notes = [...plan.notes];
  if (!spot) {
    notes.push(
      `There is no free ${plan.units.w}×${plan.units.d} space in the drawer, so the bin is waiting in the stash at the bottom of the editor. Make room and drag it in.`
    );
  }
  return {
    ok: true,
    binId: String(added.value.value),
    units: plan.units,
    placed: spot ? 'grid' : 'stash',
    notes,
  };
}
