/**
 * Messages between the Kitchen Drawers app (the parent page) and this editor
 * when it runs inside a frame. No imports: the parent app keeps a copy of this file.
 *
 * Flow: editor sends `kd:ready` -> parent sends `kd:load` -> editor sends
 * `kd:loaded`. While editing the editor sends `kd:changed`. To save, the parent
 * sends `kd:get-layout` and the editor answers `kd:layout`. To make print files
 * it sends `kd:export-print-set`; the editor builds the ZIP, uploads it to the
 * parent's own address, and answers `kd:print-set-done`.
 */

/** URL flag that switches the bridge on: `/?kd=1&kdParent=<origin of the parent page>`. */
export const KD_EMBED_PARAM = 'kd';
export const KD_PARENT_PARAM = 'kdParent';

export interface KdLoadMessage {
  type: 'kd:load';
  drawerId: string;
  name: string;
  /** Usable space inside the drawer, in millimetres. */
  interiorMm: { w: number; d: number; h: number };
  /** The drawer's saved layout exactly as this editor exported it, or null for a new drawer. */
  layoutJson: string | null;
}

export interface KdGetLayoutMessage {
  type: 'kd:get-layout';
  requestId: string;
}

export interface KdExportPrintSetMessage {
  type: 'kd:export-print-set';
  requestId: string;
  /** Name for the ZIP and the 3MF project inside it, such as `kitchen_island_d2`. */
  baseName: string;
  /** `3mf` gives one slicer project packed onto plates; `stl` gives one file per part. */
  format: '3mf' | 'stl';
  /** The chosen printer's bed, in millimetres. Plates and baseplate pieces are split to fit it. */
  bedMm: { w: number; d: number };
  /** Where to POST the finished ZIP. Must be on the parent's own origin. */
  uploadUrl: string;
}

/** A catalog item to make a fitted bin for. Lengths in millimetres. */
export interface KdFittedItem {
  id: string;
  name: string;
  /**
   * `rect`: a length x width pocket. `round`: a circle of diameter `lengthMm`.
   * `stepped`: a rectangle whose left part is deeper. `outline`: a traced shape.
   * `cradle`: stepped outlines that follow the item's underside (from a 3D scan).
   */
  shape: 'rect' | 'round' | 'stepped' | 'outline' | 'cradle';
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  /** Traced outline as a closed loop of points, for `outline`. */
  outline?: { x: number; y: number }[];
  /**
   * For `cradle`: the pocket's steps, deepest first. Each is cut `depthMm` down
   * from the top of the bin; all outlines share one coordinate frame.
   */
  levels?: { depthMm: number; outlines: { x: number; y: number }[][] }[];
  /** For `stepped`: how long the deep part is, and how deep the shallow part is cut. */
  step?: { deepLengthMm: number; shallowDepthMm: number };
}

export interface KdAddFittedBinMessage {
  type: 'kd:add-fitted-bin';
  requestId: string;
  item: KdFittedItem;
  /** Gap left around the item on every side. */
  clearanceMm: number;
  pocketDepthMm: number;
  /** Add a round dip at the back edge so a fingertip can lift the item. */
  fingerNotch: boolean;
}

/** A new bin to add. Sizes in grid units, height in height units. */
export interface KdNewBin {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  label: string;
  /** Catalog item this bin is for, with the smallest footprint the item allows. */
  itemId?: string;
  itemName?: string;
  minW?: number;
  minD?: number;
}

/**
 * Apply an accepted plan: remove some bins, move or resize others, add new ones.
 * The kitchen app has already checked the plan with the layout solver.
 */
export interface KdApplyBinsMessage {
  type: 'kd:apply-bins';
  requestId: string;
  remove: string[];
  update: { id: string; x: number; y: number; w: number; d: number; label?: string }[];
  add: KdNewBin[];
}

export type KdParentMessage =
  | KdApplyBinsMessage
  | KdLoadMessage
  | KdGetLayoutMessage
  | KdExportPrintSetMessage
  | KdAddFittedBinMessage;

export type KdEditorMessage =
  | { type: 'kd:ready' }
  | { type: 'kd:loaded'; drawerId: string }
  | { type: 'kd:load-failed'; drawerId: string; reason: string }
  | { type: 'kd:changed'; drawerId: string }
  | { type: 'kd:layout'; requestId: string; drawerId: string; layoutJson: string }
  | { type: 'kd:layout-failed'; requestId: string; reason: string }
  | {
      type: 'kd:bins-applied';
      requestId: string;
      ok: boolean;
      /** Which of the `add` entries were added, and the ids they were given. */
      added?: { index: number; binId: string }[];
      /** Plain-English lines for changes the editor refused. */
      failed?: string[];
      reason?: string;
    }
  | {
      type: 'kd:fitted-bin-done';
      requestId: string;
      ok: boolean;
      binId?: string;
      /** Bin footprint in grid units and height in height units. */
      units?: { w: number; d: number; h: number };
      /** `grid`: placed in the drawer. `stash`: no free spot, so it waits in the editor's stash. */
      placed?: 'grid' | 'stash';
      notes?: string[];
      reason?: string;
    }
  | {
      type: 'kd:print-set-done';
      requestId: string;
      ok: boolean;
      /** Plain bins that were given a default bin design so they could be exported. */
      linkedBins: number;
      reason?: string;
    };

export function isKdParentMessage(data: unknown): data is KdParentMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Record<string, unknown>;
  if (message.type === 'kd:get-layout') return typeof message.requestId === 'string';
  if (message.type === 'kd:export-print-set') {
    const bed = message.bedMm as Record<string, unknown> | null | undefined;
    return (
      typeof message.requestId === 'string' &&
      typeof message.baseName === 'string' &&
      /^[a-z0-9_-]{1,80}$/.test(message.baseName) &&
      (message.format === '3mf' || message.format === 'stl') &&
      typeof message.uploadUrl === 'string' &&
      typeof bed === 'object' &&
      bed !== null &&
      [bed.w, bed.d].every((v) => typeof v === 'number' && v >= 100 && v <= 1000)
    );
  }
  if (message.type === 'kd:apply-bins') {
    const whole = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const size = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
    const record = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null;
    return (
      typeof message.requestId === 'string' &&
      Array.isArray(message.remove) &&
      message.remove.length <= 500 &&
      message.remove.every((id: unknown) => typeof id === 'string') &&
      Array.isArray(message.update) &&
      message.update.length <= 500 &&
      message.update.every(
        (u: unknown) =>
          record(u) &&
          typeof u.id === 'string' &&
          whole(u.x) &&
          whole(u.y) &&
          size(u.w) &&
          size(u.d)
      ) &&
      Array.isArray(message.add) &&
      message.add.length <= 500 &&
      message.add.every(
        (a: unknown) =>
          record(a) &&
          whole(a.x) &&
          whole(a.y) &&
          size(a.w) &&
          size(a.d) &&
          size(a.h) &&
          typeof a.label === 'string'
      )
    );
  }
  if (message.type === 'kd:add-fitted-bin') {
    const item = message.item as Record<string, unknown> | null | undefined;
    const positive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
    const isPoint = (p: unknown): boolean =>
      typeof p === 'object' &&
      p !== null &&
      Number.isFinite((p as { x: unknown }).x) &&
      Number.isFinite((p as { y: unknown }).y);
    const levels = item?.levels;
    const levelsOk =
      levels === undefined
        ? item?.shape !== 'cradle'
        : Array.isArray(levels) &&
          levels.length >= 1 &&
          levels.length <= 12 &&
          levels.every(
            (level: unknown) =>
              typeof level === 'object' &&
              level !== null &&
              positive((level as { depthMm: unknown }).depthMm) &&
              Array.isArray((level as { outlines: unknown }).outlines) &&
              (level as { outlines: unknown[] }).outlines.length >= 1 &&
              (level as { outlines: unknown[] }).outlines.length <= 8 &&
              (level as { outlines: unknown[] }).outlines.every(
                (outline) =>
                  Array.isArray(outline) &&
                  outline.length >= 3 &&
                  outline.length <= 200 &&
                  outline.every(isPoint)
              )
          );
    return (
      levelsOk &&
      typeof message.requestId === 'string' &&
      typeof item === 'object' &&
      item !== null &&
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      ['rect', 'round', 'stepped', 'outline', 'cradle'].includes(item.shape as string) &&
      positive(item.lengthMm) &&
      positive(item.widthMm) &&
      positive(item.heightMm) &&
      (item.outline === undefined ||
        (Array.isArray(item.outline) &&
          item.outline.length <= 200 &&
          item.outline.every(
            (p: unknown) =>
              typeof p === 'object' &&
              p !== null &&
              Number.isFinite((p as { x: unknown }).x) &&
              Number.isFinite((p as { y: unknown }).y)
          ))) &&
      typeof message.clearanceMm === 'number' &&
      positive(message.pocketDepthMm) &&
      typeof message.fingerNotch === 'boolean'
    );
  }
  if (message.type !== 'kd:load') return false;
  const size = message.interiorMm as Record<string, unknown> | null | undefined;
  return (
    typeof message.drawerId === 'string' &&
    typeof message.name === 'string' &&
    (message.layoutJson === null || typeof message.layoutJson === 'string') &&
    typeof size === 'object' &&
    size !== null &&
    [size.w, size.d, size.h].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
  );
}

/** The parent origin named in the URL, or null when the editor is not embedded. */
export function readKdParentOrigin(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get(KD_EMBED_PARAM) !== '1') return null;
  const parent = params.get(KD_PARENT_PARAM);
  if (parent === null) return null;
  try {
    const url = new URL(parent);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}
