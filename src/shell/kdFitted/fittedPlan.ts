/**
 * Kitchen Drawers fork: work out a fitted bin for one catalog item. Pure: it
 * turns an item's measurements into bin-design parameters (a solid bin with a
 * pocket cut into it) and says how big the bin has to be. Saving the design
 * and placing the bin happen in `addFittedBin.ts`.
 */
import { getInteriorDims } from '@/features/bin-designer/utils/dividerAngle';
import { createDefaultCutout } from '@/features/bin-designer/components/panel/CutoutsSection/cutoutHelpers';
import type { Cutout, PathPoint } from '@/features/bin-designer/types/cutout';
import type { KdAddFittedBinMessage } from '@/shared/kdEmbed/protocol';
import type { BinParams } from '@/shared/types/bin';

/** Solid plastic left around the pocket on every side, mm. */
const MARGIN_MM = 2;
/** Width of the finger notch, mm: enough for a fingertip. */
const NOTCH_MM = 24;
/** Plastic left under the deepest pocket, above the bin's 7 mm base, mm. */
const FLOOR_MM = 1;
const MAX_UNITS = 12;

export interface FittedPlan {
  params: BinParams;
  /** Bin footprint in grid units and height in height units. */
  units: { w: number; d: number; h: number };
  /** Pocket depth actually used, mm (it may be shallower than asked if the drawer is low). */
  pocketDepthMm: number;
  /** Plain-English remarks about adjustments that were made. */
  notes: string[];
}

function pocketSize(item: KdAddFittedBinMessage['item']): { w: number; d: number } {
  if (item.shape === 'round') return { w: item.lengthMm, d: item.lengthMm };
  if (item.shape === 'outline' && item.outline && item.outline.length >= 3) {
    const xs = item.outline.map((p) => p.x);
    const ys = item.outline.map((p) => p.y);
    return { w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) };
  }
  return { w: item.lengthMm, d: item.widthMm };
}

/** Drop repeated points: the generator falls back to a plain box when a path has consecutive duplicates. */
function cleanOutline(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (out.length === 0 || Math.hypot(point.x - last.x, point.y - last.y) > 0.05) out.push(point);
  }
  const first = out[0];
  const end = out[out.length - 1];
  if (out.length > 1 && Math.hypot(first.x - end.x, first.y - end.y) <= 0.05) out.pop();
  return out;
}

/**
 * Plan the smallest bin that holds the item's pocket.
 * `defaults` is the user's default bin; `layout` supplies the grid and the drawer's height.
 */
export function kdPlanFittedBin(
  message: KdAddFittedBinMessage,
  defaults: BinParams,
  layout: { gridUnitMm: number; heightUnitMm: number; drawerHeightUnits: number }
): FittedPlan | string {
  const { item } = message;
  const notes: string[] = [];
  const clearance = Math.min(5, Math.max(0, message.clearanceMm));
  const pocket = pocketSize(item);
  if (pocket.w <= 0 || pocket.d <= 0) return 'That item has no size to make a pocket from.';
  const notch = message.fingerNotch ? NOTCH_MM / 2 : 0;
  const needW = pocket.w + 2 * clearance + 2 * MARGIN_MM;
  const needD = pocket.d + 2 * clearance + 2 * MARGIN_MM + notch;

  const base: BinParams = {
    ...defaults,
    // The generator only fills the bin when BOTH of these say solid; with the
    // style alone it exports an ordinary hollow bin and silently drops the pocket.
    style: 'solid',
    base: { ...defaults.base, solid: true },
    gridUnitMm: layout.gridUnitMm,
    heightUnitMm: layout.heightUnitMm,
    fractionalEdgeManualX: false,
    fractionalEdgeManualY: false,
    cutouts: [],
    cutoutConfig: { topOffset: 0, fillReference: 'rim' },
  };
  const fit = (need: number, axis: 'innerW' | 'innerD'): number | null => {
    for (let units = 1; units <= MAX_UNITS; units++) {
      if (getInteriorDims({ ...base, width: units, depth: units })[axis] >= need) return units;
    }
    return null;
  };
  const w = fit(needW, 'innerW');
  const d = fit(needD, 'innerD');
  if (w === null || d === null) {
    return `That item needs a bin larger than ${MAX_UNITS}×${MAX_UNITS} grid units.`;
  }

  // Height: the base takes one height unit; the pocket and a thin floor go above it.
  const maxH = Math.max(2, Math.floor(layout.drawerHeightUnits));
  const wantedH = Math.ceil((message.pocketDepthMm + FLOOR_MM) / layout.heightUnitMm) + 1;
  const h = Math.min(Math.max(2, wantedH), maxH);
  const deepest = (h - 1) * layout.heightUnitMm - FLOOR_MM;
  const pocketDepthMm = Math.min(message.pocketDepthMm, deepest);
  if (pocketDepthMm < message.pocketDepthMm) {
    notes.push(
      `The drawer is ${maxH} height units tall, so the pocket is ${pocketDepthMm.toFixed(1)} mm deep instead of ${message.pocketDepthMm.toFixed(1)} mm.`
    );
  }

  const sized: BinParams = { ...base, width: w, depth: d, height: h };
  const { innerW, innerD } = getInteriorDims(sized);
  const x = (innerW - pocket.w) / 2;
  const y = (innerD - notch - pocket.d) / 2;

  const shape = item.shape === 'round' ? 'circle' : item.shape === 'outline' ? 'path' : 'rectangle';
  let cut: Cutout = {
    ...createDefaultCutout('kd-pocket', shape, x, y, pocket.w, pocket.d),
    cutDepth: pocketDepthMm,
    clearance,
    name: item.name.slice(0, 40),
    ...(shape === 'rectangle' ? { cornerRadius: Math.min(2, pocket.w / 4, pocket.d / 4) } : {}),
  };

  if (item.shape === 'outline' && item.outline) {
    const points = cleanOutline(item.outline);
    if (points.length < 3) return 'That outline has too few points to cut a pocket from.';
    const minX = Math.min(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const path: PathPoint[] = points.map((p) => ({
      x: x + p.x - minX,
      y: y + p.y - minY,
      handleIn: null,
      handleOut: null,
      symmetric: false,
    }));
    cut = { ...cut, path };
  }

  if (item.shape === 'stepped' && item.step) {
    // The left part (deepLengthMm long) is cut to the full depth; the rest only to shallowDepthMm.
    const deepLength = Math.min(Math.max(item.step.deepLengthMm, 1), pocket.w - 1);
    const lineX = deepLength - pocket.w / 2;
    const shallow = Math.min(Math.max(item.step.shallowDepthMm, 0.5), pocketDepthMm);
    cut = {
      ...cut,
      split: {
        a: { x: lineX, y: -pocket.d / 2 - 1 },
        b: { x: lineX, y: pocket.d / 2 + 1 },
        cutDepth: shallow,
      },
    };
  }

  const cutouts: Cutout[] = [cut];
  if (message.fingerNotch) {
    // A round dip centred on the pocket's back edge, so a fingertip gets under the item.
    cutouts.push({
      ...createDefaultCutout(
        'kd-finger',
        'circle',
        x + pocket.w / 2 - NOTCH_MM / 2,
        y + pocket.d + clearance - NOTCH_MM / 2,
        NOTCH_MM,
        NOTCH_MM
      ),
      cutDepth: Math.min(pocketDepthMm, 15),
      finger: { bottom: 'curved' },
      name: 'Finger notch',
    });
  }

  return { params: { ...sized, cutouts }, units: { w, d, h }, pocketDepthMm, notes };
}
