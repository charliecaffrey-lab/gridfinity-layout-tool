/**
 * Bridge between the editor's layout types and the pure solver in `solver.ts`.
 * Everything the editor asks of the solver goes through this file.
 */
import type { Bin, BinId, GridUnits, LayerId, Layout, Rect } from '@/core/types';
import { canPlaceBin } from '@/shared/utils/validation';
import { useKdSolverSettings } from './settings';
import { fillGaps, orderChanges, removeBin, resizeBinBestEffort } from './solver';
import type { SolverBin, SolverRect } from './solver';

/**
 * Minimum footprint a bin may be shrunk to, in grid units, stored on the bin's
 * custom properties. Written when a catalog item is assigned to the bin.
 */
export const KD_MIN_W_KEY = 'kd.minW';
export const KD_MIN_D_KEY = 'kd.minD';

function minimum(bin: Bin, key: string): number | undefined {
  const value = Number(bin.customProperties?.[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function toSolverBin(bin: Bin): SolverBin {
  return {
    id: bin.id,
    x: bin.x,
    y: bin.y,
    w: bin.width,
    d: bin.depth,
    locked: bin.locked === true,
    minW: minimum(bin, KD_MIN_W_KEY),
    minD: minimum(bin, KD_MIN_D_KEY),
    name: bin.label,
  };
}

function solverBins(layout: Layout, layerId: LayerId): SolverBin[] {
  return layout.bins.filter((bin) => bin.layerId === layerId).map(toSolverBin);
}

function toRect(rect: SolverRect): Rect {
  return {
    x: rect.x as GridUnits,
    y: rect.y as GridUnits,
    width: rect.w as GridUnits,
    depth: rect.d as GridUnits,
  };
}

export interface KdResizePlan {
  /** New footprint for every bin the resize touches, the resized bin included. */
  rects: Map<BinId, Rect>;
  /** Bins other than the resized one that move or change size. */
  neighborIds: BinId[];
  /** Why the full drag could not be met, when it could not. */
  blockedMessage?: string;
}

/**
 * Work out what a resize does to the bin and its neighbors under the current
 * mode. Returns null when the editor's own rules (odd-shaped drawers, stacked
 * layers, height limits) reject the result, so the caller can fall back.
 */
export function kdPlanResize(args: {
  layout: Layout;
  layerId: LayerId;
  binId: BinId;
  requested: Rect;
  halfGrid: boolean;
}): KdResizePlan | null {
  const { layout, layerId, binId, requested, halfGrid } = args;
  const { mode, freed } = useKdSolverSettings.getState();
  const result = resizeBinBestEffort(
    solverBins(layout, layerId),
    { width: layout.drawer.width, depth: layout.drawer.depth },
    binId,
    { x: requested.x, y: requested.y, w: requested.width, d: requested.depth },
    { mode, freed, step: halfGrid ? 0.5 : 1 }
  );

  const rects = new Map<BinId, Rect>();
  for (const change of result.changes) rects.set(change.id as BinId, toRect(change));
  const moving = new Set(rects.keys());
  for (const [id, rect] of rects) {
    const bin = layout.bins.find((b) => b.id === id);
    if (!bin) return null;
    const check = canPlaceBin({ ...rect, height: bin.height }, layerId, layout, id, moving);
    if (!check.valid) return null;
  }

  if (!rects.has(binId)) rects.set(binId, toRect(result.rect));
  return {
    rects,
    neighborIds: [...rects.keys()].filter((id) => id !== binId),
    blockedMessage: result.failure?.message,
  };
}

/** Order a set of footprint changes so each can be applied on its own without a collision. */
export function kdOrderedUpdates(
  layout: Layout,
  layerId: LayerId,
  rects: ReadonlyMap<BinId, Rect>
): Array<{ id: BinId; rect: Rect }> {
  const changes = [...rects].map(([id, rect]) => ({
    id,
    x: rect.x,
    y: rect.y,
    w: rect.width,
    d: rect.depth,
  }));
  return orderChanges(solverBins(layout, layerId), changes).map((change) => ({
    id: change.id as BinId,
    rect: toRect(change),
  }));
}

/** Footprints that "Fill empty space" would add to a layer under the current size limit. */
export function kdPlanFill(layout: Layout, layerId: LayerId, halfGrid: boolean): Rect[] {
  const layer = layout.layers.find((l) => l.id === layerId);
  if (!layer) return [];
  const { fillMaxW, fillMaxD } = useKdSolverSettings.getState();
  return fillGaps(
    solverBins(layout, layerId),
    { width: layout.drawer.width, depth: layout.drawer.depth },
    {
      maxW: fillMaxW,
      maxD: fillMaxD,
      step: halfGrid ? 0.5 : 1,
      allowed: (rect) =>
        canPlaceBin({ ...toRect(rect), height: layer.height }, layerId, layout).valid,
    }
  ).map(toRect);
}

/** Neighbor changes that hand a deleted bin's space over, in Absorb mode. */
export function kdPlanAbsorbDeleted(
  layoutBefore: Layout,
  deleted: Bin
): Array<{ id: BinId; rect: Rect }> {
  if (useKdSolverSettings.getState().freed !== 'absorb') return [];
  const result = removeBin(
    solverBins(layoutBefore, deleted.layerId),
    { width: layoutBefore.drawer.width, depth: layoutBefore.drawer.depth },
    deleted.id,
    { freed: 'absorb' }
  );
  if (!result.ok) return [];
  return result.changes.map((change) => ({ id: change.id as BinId, rect: toRect(change) }));
}

export function kdPinnedMessage(bin: Pick<Bin, 'label'>): string {
  const name = bin.label.trim() === '' ? 'This bin' : `"${bin.label.trim()}"`;
  return `${name} is pinned. Unlock it to move or resize it.`;
}

let blockedMessage: string | undefined;

/** The resize hook records why a drag was held back; the drop handler shows it once. */
export function kdSetBlockedMessage(message: string | undefined): void {
  blockedMessage = message;
}

export function kdTakeBlockedMessage(): string | undefined {
  const message = blockedMessage;
  blockedMessage = undefined;
  return message;
}
