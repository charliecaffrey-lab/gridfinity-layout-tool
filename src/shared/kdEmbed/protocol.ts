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

export type KdParentMessage = KdLoadMessage | KdGetLayoutMessage | KdExportPrintSetMessage;

export type KdEditorMessage =
  | { type: 'kd:ready' }
  | { type: 'kd:loaded'; drawerId: string }
  | { type: 'kd:load-failed'; drawerId: string; reason: string }
  | { type: 'kd:changed'; drawerId: string }
  | { type: 'kd:layout'; requestId: string; drawerId: string; layoutJson: string }
  | { type: 'kd:layout-failed'; requestId: string; reason: string }
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
