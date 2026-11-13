/**
 * Kitchen Drawers layout solver.
 *
 * Plain, deterministic TypeScript with no imports, so the same file runs in the
 * editor (during a drag) and on a server (checking a proposed layout).
 *
 * Positions and sizes are Gridfinity grid units with the origin at the drawer's
 * front-left corner: x grows right, y grows toward the back. Half units (0.5)
 * are allowed. Internally everything is doubled into whole "ticks" so no
 * arithmetic ever happens on fractions.
 */

export interface SolverBin {
  id: string;
  x: number;
  y: number;
  w: number;
  d: number;
  /** Pinned: nothing may move or resize this bin. */
  locked?: boolean;
  /** Smallest footprint this bin may be squeezed or resized to. Defaults to 1 x 1. */
  minW?: number;
  minD?: number;
  /** Used in messages. Falls back to a description of size and position. */
  name?: string;
}

export interface SolverDrawer {
  width: number;
  depth: number;
}

export interface SolverRect {
  x: number;
  y: number;
  w: number;
  d: number;
}

/** What happens to neighbors when a bin grows into them. */
export type ResizeMode = 'push' | 'squeeze' | 'fixed';
/** What happens to space a bin gives up. */
export type FreedMode = 'absorb' | 'leaveGap';

export interface SolverOptions {
  mode: ResizeMode;
  freed: FreedMode;
  /** Grid step: 1, or 0.5 in half-grid mode. */
  step?: number;
}

export interface SolverChange extends SolverRect {
  id: string;
}

export type FailureCode =
  | 'not_found'
  | 'pinned'
  | 'off_grid'
  | 'out_of_bounds'
  | 'below_minimum'
  | 'blocked_by_pinned'
  | 'blocked_by_bin'
  | 'no_room'
  | 'overlap';

export interface SolverFailure {
  code: FailureCode;
  /** The bin that stops the change, when there is one. */
  blockerId?: string;
  /** Plain-English reason, ready to show. */
  message: string;
}

export type SolverResult =
  { ok: true; changes: SolverChange[] } | { ok: false; failure: SolverFailure };

const TICKS = 2;
const toTicks = (units: number): number => Math.round(units * TICKS);
const toUnits = (ticks: number): number => ticks / TICKS;

interface Box {
  x: number;
  y: number;
  w: number;
  d: number;
}

const right = (b: Box): number => b.x + b.w;
const back = (b: Box): number => b.y + b.d;
const overlaps = (a: Box, b: Box): boolean =>
  a.x < right(b) && b.x < right(a) && a.y < back(b) && b.y < back(a);
const sameBox = (a: Box, b: Box): boolean =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.d === b.d;
const boxOf = (r: SolverRect): Box => ({
  x: toTicks(r.x),
  y: toTicks(r.y),
  w: toTicks(r.w),
  d: toTicks(r.d),
});

function describe(bin: SolverBin): string {
  if (bin.name !== undefined && bin.name.trim() !== '') return `"${bin.name.trim()}"`;
  return `the ${bin.w}×${bin.d} bin at column ${Math.floor(bin.x) + 1}, row ${Math.floor(bin.y) + 1}`;
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function fail(code: FailureCode, message: string, blockerId?: string): SolverResult {
  return {
    ok: false,
    failure: {
      code,
      message: sentence(message),
      ...(blockerId !== undefined ? { blockerId } : {}),
    },
  };
}

function minUnits(bin: SolverBin): { w: number; d: number } {
  // A bin already smaller than 1 x 1 (half-grid) keeps its own size as the floor.
  return { w: bin.minW ?? Math.min(1, bin.w), d: bin.minD ?? Math.min(1, bin.d) };
}

class Board {
  readonly boxes = new Map<string, Box>();
  readonly bins = new Map<string, SolverBin>();
  readonly width: number;
  readonly depth: number;

  constructor(bins: readonly SolverBin[], drawer: SolverDrawer) {
    this.width = toTicks(drawer.width);
    this.depth = toTicks(drawer.depth);
    for (const bin of bins) {
      this.bins.set(bin.id, bin);
      this.boxes.set(bin.id, boxOf(bin));
    }
  }

  bin(id: string): SolverBin {
    const bin = this.bins.get(id);
    if (bin === undefined) throw new Error(`Unknown bin ${id}`);
    return bin;
  }

  box(id: string): Box {
    const box = this.boxes.get(id);
    if (box === undefined) throw new Error(`Unknown bin ${id}`);
    return box;
  }

  inBounds(box: Box): boolean {
    return box.x >= 0 && box.y >= 0 && right(box) <= this.width && back(box) <= this.depth;
  }

  /** Ids of bins overlapping `box`, nearest first along the given axis and direction. */
  hits(box: Box, exclude: string, axis: 'x' | 'y', sign: 1 | -1): string[] {
    const found: string[] = [];
    for (const [id, other] of this.boxes) {
      if (id !== exclude && overlaps(box, other)) found.push(id);
    }
    return found.sort((a, b) => {
      const pa = this.box(a)[axis];
      const pb = this.box(b)[axis];
      return pa !== pb ? (pa - pb) * sign : a < b ? -1 : 1;
    });
  }

  firstOverlap(box: Box, exclude: string): string | undefined {
    const ids = [...this.boxes.keys()].sort();
    return ids.find((id) => id !== exclude && overlaps(box, this.box(id)));
  }

  /** Every box that differs from where its bin started, in id order. */
  changes(): SolverChange[] {
    const out: SolverChange[] = [];
    for (const id of [...this.boxes.keys()].sort()) {
      const box = this.box(id);
      if (!sameBox(box, boxOf(this.bin(id)))) {
        out.push({
          id,
          x: toUnits(box.x),
          y: toUnits(box.y),
          w: toUnits(box.w),
          d: toUnits(box.d),
        });
      }
    }
    return out;
  }

  /** Last line of defence: no result leaves the solver with an overlap or a bin outside the drawer. */
  check(): SolverResult | null {
    const ids = [...this.boxes.keys()].sort();
    for (let i = 0; i < ids.length; i++) {
      const a = this.box(ids[i]);
      if (!this.inBounds(a)) {
        return fail(
          'out_of_bounds',
          `${describe(this.bin(ids[i]))} would leave the drawer.`,
          ids[i]
        );
      }
      for (let j = i + 1; j < ids.length; j++) {
        if (overlaps(a, this.box(ids[j]))) {
          return fail(
            'overlap',
            `${describe(this.bin(ids[i]))} would overlap ${describe(this.bin(ids[j]))}.`,
            ids[j]
          );
        }
      }
    }
    return null;
  }
}

function onGrid(rect: SolverRect, step: number): boolean {
  const stepTicks = toTicks(step);
  return [rect.x, rect.y, rect.w, rect.d].every((v) => {
    const ticks = v * TICKS;
    return Number.isInteger(ticks) && ticks % stepTicks === 0;
  });
}

function directionWord(axis: 'x' | 'y', sign: 1 | -1): string {
  if (axis === 'x') return sign === 1 ? 'right' : 'left';
  return sign === 1 ? 'back' : 'front';
}

/**
 * Clear everything out of `pusher`'s way along one axis.
 * Push shifts neighbors (and whatever they bump into), Squeeze trims them, Fixed refuses.
 */
function makeRoom(
  board: Board,
  pusherId: string,
  axis: 'x' | 'y',
  sign: 1 | -1,
  mode: ResizeMode
): SolverResult | null {
  const size = axis === 'x' ? 'w' : 'd';
  const limit = axis === 'x' ? board.width : board.depth;
  const queue = [pusherId];
  // Each pass moves a bin strictly further along the axis, so this always ends.
  for (let currentId = queue.shift(); currentId !== undefined; currentId = queue.shift()) {
    const current = board.box(currentId);
    const hits = board.hits(current, currentId, axis, sign);
    // A pinned bin is the real obstacle even when a nearer bin would run out of room first.
    const pinned = hits.find((id) => board.bin(id).locked === true);
    if (pinned !== undefined) {
      return fail(
        'blocked_by_pinned',
        `${describe(board.bin(pinned))} is pinned and is in the way.`,
        pinned
      );
    }
    for (const id of hits) {
      const bin = board.bin(id);
      const box = board.box(id);
      if (mode === 'fixed') {
        return fail(
          'blocked_by_bin',
          `${describe(bin)} is in the way. Fixed mode stops at the first neighbor.`,
          id
        );
      }
      const edge = sign === 1 ? current[axis] + current[size] : current[axis];
      if (mode === 'squeeze') {
        const kept = sign === 1 ? box[axis] + box[size] - edge : edge - box[axis];
        const min = minUnits(bin);
        if (kept < toTicks(min[size])) {
          return fail(
            'below_minimum',
            `${describe(bin)} can't shrink below its minimum size of ${min.w}×${min.d}.`,
            id
          );
        }
        if (sign === 1) box[axis] = edge;
        box[size] = kept;
        continue;
      }
      box[axis] = sign === 1 ? edge : edge - box[size];
      if (box[axis] < 0 || box[axis] + box[size] > limit) {
        return fail(
          'no_room',
          `There is no room to push ${describe(bin)} any further ${directionWord(axis, sign)}.`,
          id
        );
      }
      queue.push(id);
    }
  }
  return null;
}

type Side = 'left' | 'right' | 'front' | 'back';

/**
 * Neighbors that touch one side of `gap` and fit entirely within its span on that side.
 * Only those can take the space while staying rectangles.
 */
function absorbers(board: Board, gap: Box, side: Side, exclude: string): string[] {
  const found: string[] = [];
  for (const [id, box] of board.boxes) {
    if (id === exclude || board.bin(id).locked === true) continue;
    const within =
      side === 'left' || side === 'right'
        ? box.y >= gap.y && back(box) <= back(gap)
        : box.x >= gap.x && right(box) <= right(gap);
    const touching =
      side === 'left'
        ? right(box) === gap.x
        : side === 'right'
          ? box.x === right(gap)
          : side === 'front'
            ? back(box) === gap.y
            : box.y === back(gap);
    if (within && touching) found.push(id);
  }
  return found.sort();
}

/** Stretch a neighbor across the gap, unless something else already took that space. */
function stretchInto(board: Board, id: string, gap: Box, side: Side): void {
  const box = board.box(id);
  const grown: Box = { ...box };
  if (side === 'left') grown.w = right(gap) - box.x;
  else if (side === 'right') {
    grown.x = gap.x;
    grown.w = right(box) - gap.x;
  } else if (side === 'front') grown.d = back(gap) - box.y;
  else {
    grown.y = gap.y;
    grown.d = back(box) - gap.y;
  }
  for (const [otherId, other] of board.boxes) {
    if (otherId !== id && overlaps(grown, other)) return;
  }
  board.boxes.set(id, grown);
}

/**
 * A bin that grows both left and right in one step must push each side its own way.
 * Temporarily narrow the bin to the side being cleared so the other side's
 * neighbors are not mistaken for obstacles in this direction.
 */
function makeRoomOnSide(
  board: Board,
  id: string,
  axis: 'x' | 'y',
  sign: 1 | -1,
  before: Box,
  mode: ResizeMode
): SolverResult | null {
  const full = { ...board.box(id) };
  const size = axis === 'x' ? 'w' : 'd';
  const oneSide: Box = { ...full };
  if (sign === 1) {
    oneSide[axis] = before[axis];
    oneSide[size] = full[axis] + full[size] - before[axis];
  } else {
    oneSide[size] = before[axis] + before[size] - full[axis];
  }
  board.boxes.set(id, oneSide);
  const blocked = makeRoom(board, id, axis, sign, mode);
  board.boxes.set(id, full);
  return blocked;
}

/** Resize (or resize and shift) one bin, adjusting its neighbors according to the options. */
export function resizeBin(
  bins: readonly SolverBin[],
  drawer: SolverDrawer,
  id: string,
  target: SolverRect,
  options: SolverOptions
): SolverResult {
  const self = bins.find((b) => b.id === id);
  if (self === undefined) return fail('not_found', 'That bin no longer exists.');
  if (self.locked === true) {
    return fail('pinned', `${describe(self)} is pinned. Unpin it to move or resize it.`, id);
  }
  if (!onGrid(target, options.step ?? 1) || target.w <= 0 || target.d <= 0) {
    return fail('off_grid', 'That size does not line up with the grid.');
  }
  const board = new Board(bins, drawer);
  const goal = boxOf(target);
  if (!board.inBounds(goal)) {
    return fail('out_of_bounds', `${describe(self)} would stick out of the drawer.`);
  }
  const min = minUnits(self);
  if (goal.w < toTicks(min.w) || goal.d < toTicks(min.d)) {
    return fail(
      'below_minimum',
      `${describe(self)} can't be smaller than ${min.w}×${min.d}, the space its contents need.`,
      id
    );
  }

  const old = board.box(id);
  if (!overlaps(old, goal)) {
    return fail('off_grid', 'A resize has to keep part of the bin where it was.');
  }

  // 1. Give up space first, so neighbors can take it before anything grows.
  const kept: Box = {
    x: Math.max(old.x, goal.x),
    y: Math.max(old.y, goal.y),
    w: Math.min(right(old), right(goal)) - Math.max(old.x, goal.x),
    d: Math.min(back(old), back(goal)) - Math.max(old.y, goal.y),
  };
  board.boxes.set(id, kept);
  if (options.freed === 'absorb') {
    const strips: Array<[Side, Box]> = [
      ['left', { x: old.x, y: old.y, w: kept.x - old.x, d: old.d }],
      ['right', { x: right(kept), y: old.y, w: right(old) - right(kept), d: old.d }],
      ['front', { x: old.x, y: old.y, w: old.w, d: kept.y - old.y }],
      ['back', { x: old.x, y: back(kept), w: old.w, d: back(old) - back(kept) }],
    ];
    for (const [side, strip] of strips) {
      if (strip.w <= 0 || strip.d <= 0) continue;
      for (const neighbor of absorbers(board, strip, side, id)) {
        stretchInto(board, neighbor, strip, side);
      }
    }
  }

  // 2. Grow sideways, then front to back. A bin sitting diagonally is handled by the second pass.
  const wide: Box = { x: goal.x, y: kept.y, w: goal.w, d: kept.d };
  board.boxes.set(id, wide);
  for (const sign of [1, -1] as const) {
    const grew = sign === 1 ? right(wide) > right(kept) : wide.x < kept.x;
    if (!grew) continue;
    const blocked = makeRoomOnSide(board, id, 'x', sign, kept, options.mode);
    if (blocked !== null) return blocked;
  }
  board.boxes.set(id, goal);
  for (const sign of [1, -1] as const) {
    const grew = sign === 1 ? back(goal) > back(wide) : goal.y < wide.y;
    if (!grew) continue;
    const blocked = makeRoomOnSide(board, id, 'y', sign, wide, options.mode);
    if (blocked !== null) return blocked;
  }

  return board.check() ?? { ok: true, changes: board.changes() };
}

/** Move one bin without changing its size. Nothing else moves. */
export function moveBin(
  bins: readonly SolverBin[],
  drawer: SolverDrawer,
  id: string,
  to: { x: number; y: number },
  options: Pick<SolverOptions, 'step'> = {}
): SolverResult {
  const self = bins.find((b) => b.id === id);
  if (self === undefined) return fail('not_found', 'That bin no longer exists.');
  if (self.locked === true) {
    return fail('pinned', `${describe(self)} is pinned. Unpin it to move or resize it.`, id);
  }
  const target = { x: to.x, y: to.y, w: self.w, d: self.d };
  if (!onGrid(target, options.step ?? 1)) {
    return fail('off_grid', 'That position does not line up with the grid.');
  }
  const board = new Board(bins, drawer);
  const goal = boxOf(target);
  if (!board.inBounds(goal)) {
    return fail('out_of_bounds', `${describe(self)} would stick out of the drawer.`);
  }
  const blocker = board.firstOverlap(goal, id);
  if (blocker !== undefined) {
    return fail('blocked_by_bin', `${describe(board.bin(blocker))} is in the way.`, blocker);
  }
  board.boxes.set(id, goal);
  return { ok: true, changes: board.changes() };
}

/** Check that a new bin fits. Returns no changes: adding never moves anything else. */
export function addBin(
  bins: readonly SolverBin[],
  drawer: SolverDrawer,
  bin: SolverBin,
  options: Pick<SolverOptions, 'step'> = {}
): SolverResult {
  if (!onGrid(bin, options.step ?? 1) || bin.w <= 0 || bin.d <= 0) {
    return fail('off_grid', 'That bin does not line up with the grid.');
  }
  const board = new Board(bins, drawer);
  const goal = boxOf(bin);
  if (!board.inBounds(goal)) {
    return fail('out_of_bounds', `${describe(bin)} would stick out of the drawer.`);
  }
  const blocker = board.firstOverlap(goal, bin.id);
  if (blocker !== undefined) {
    return fail('blocked_by_bin', `${describe(board.bin(blocker))} is in the way.`, blocker);
  }
  return { ok: true, changes: [] };
}

const SIDES: readonly Side[] = ['left', 'right', 'front', 'back'];

/**
 * Remove a bin. With Absorb, the neighbors on the one side that can cover the
 * most of the hole stretch across it (ties go left, right, front, back).
 * The returned changes are for the neighbors only; the caller deletes the bin.
 */
export function removeBin(
  bins: readonly SolverBin[],
  drawer: SolverDrawer,
  id: string,
  options: Pick<SolverOptions, 'freed'>
): SolverResult {
  if (!bins.some((b) => b.id === id)) return fail('not_found', 'That bin no longer exists.');
  const board = new Board(bins, drawer);
  const hole = { ...board.box(id) };
  board.boxes.delete(id);
  if (options.freed === 'absorb') {
    let best: { side: Side; ids: string[]; covered: number } | null = null;
    for (const side of SIDES) {
      const ids = absorbers(board, hole, side, id);
      const covered = ids.reduce((sum, n) => {
        const box = board.box(n);
        return sum + (side === 'left' || side === 'right' ? box.d : box.w);
      }, 0);
      if (covered > 0 && (best === null || covered > best.covered)) best = { side, ids, covered };
    }
    if (best !== null) {
      for (const neighbor of best.ids) stretchInto(board, neighbor, hole, best.side);
    }
  }
  return board.check() ?? { ok: true, changes: board.changes() };
}

export interface FillOptions {
  /** Largest bin to create, in grid units. */
  maxW: number;
  maxD: number;
  step?: number;
  /** Extra rule from the caller (for example an odd-shaped drawer). Return false to keep a spot empty. */
  allowed?: (rect: SolverRect) => boolean;
}

/**
 * Pack the empty space with the largest bins that fit, up to the size limit.
 * Scans front to back, left to right. At each empty cell it places the biggest
 * rectangle that starts there (larger area wins, then wider).
 */
export function fillGaps(
  bins: readonly SolverBin[],
  drawer: SolverDrawer,
  options: FillOptions
): SolverRect[] {
  const step = toTicks(options.step ?? 1);
  const width = toTicks(drawer.width);
  const depth = toTicks(drawer.depth);
  const maxW = Math.max(step, Math.floor(toTicks(options.maxW) / step) * step);
  const maxD = Math.max(step, Math.floor(toTicks(options.maxD) / step) * step);
  const taken: Box[] = bins.map(boxOf);
  const free = (box: Box): boolean =>
    right(box) <= width && back(box) <= depth && !taken.some((t) => overlaps(box, t));
  const allowed = (box: Box): boolean =>
    options.allowed === undefined ||
    options.allowed({
      x: toUnits(box.x),
      y: toUnits(box.y),
      w: toUnits(box.w),
      d: toUnits(box.d),
    });

  const placed: SolverRect[] = [];
  for (let y = 0; y + step <= depth; y += step) {
    for (let x = 0; x + step <= width; x += step) {
      if (!free({ x, y, w: step, d: step })) continue;
      let best: Box | null = null;
      let limitW = maxW;
      for (let d = step; d <= maxD && limitW >= step; d += step) {
        // Rows further back can only be as wide as the narrowest row so far.
        let w = 0;
        while (w + step <= limitW && free({ x: x + w, y: y + d - step, w: step, d: step })) {
          w += step;
        }
        if (w === 0) break;
        limitW = w;
        // The widest candidate at this depth wins unless the caller's rule rejects it.
        for (let cw = w; cw >= step; cw -= step) {
          const candidate: Box = { x, y, w: cw, d };
          if (!allowed(candidate)) continue;
          const area = cw * d;
          const bestArea: number = best === null ? 0 : best.w * best.d;
          const wider: boolean = best !== null && cw > best.w;
          if (area > bestArea || (area === bestArea && wider)) best = candidate;
          break;
        }
      }
      if (best === null) continue;
      taken.push(best);
      placed.push({
        x: toUnits(best.x),
        y: toUnits(best.y),
        w: toUnits(best.w),
        d: toUnits(best.d),
      });
    }
  }
  return placed;
}

/**
 * Put a set of changes in an order where each one can be applied by itself
 * without overlapping a bin that has not moved yet (for example: when pushing
 * right, the farthest bin goes first).
 */
export function orderChanges(
  bins: readonly SolverBin[],
  changes: readonly SolverChange[]
): SolverChange[] {
  const current = new Map<string, Box>(bins.map((b) => [b.id, boxOf(b)]));
  const pending = [...changes].sort((a, b) => (a.id < b.id ? -1 : 1));
  const ordered: SolverChange[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex((change) => {
      const goal = boxOf(change);
      for (const [id, box] of current) {
        if (id !== change.id && overlaps(goal, box)) return false;
      }
      return true;
    });
    // A valid plan always has a next step; if not, hand the rest back unchanged.
    if (index === -1) return [...ordered, ...pending];
    const [next] = pending.splice(index, 1);
    current.set(next.id, boxOf(next));
    ordered.push(next);
  }
  return ordered;
}

export interface BestEffortResult {
  /** Where the resized bin ends up (equal to its start if nothing was possible). */
  rect: SolverRect;
  changes: SolverChange[];
  /** Set when the full request could not be met: why, and which bin stopped it. */
  failure?: SolverFailure;
}

/**
 * Resize as far as the rules allow. Tries the requested size, then walks each
 * edge back toward where it started, one grid step at a time, until it fits.
 */
export function resizeBinBestEffort(
  bins: readonly SolverBin[],
  drawer: SolverDrawer,
  id: string,
  target: SolverRect,
  options: SolverOptions
): BestEffortResult {
  const self = bins.find((b) => b.id === id);
  const first = resizeBin(bins, drawer, id, target, options);
  if (first.ok) return { rect: target, changes: first.changes };
  if (self === undefined) return { rect: target, changes: [], failure: first.failure };

  const step = toTicks(options.step ?? 1);
  const start = boxOf(self);
  const edges = {
    left: toTicks(target.x),
    right: toTicks(target.x + target.w),
    front: toTicks(target.y),
    back: toTicks(target.y + target.d),
  };
  const home = { left: start.x, right: right(start), front: start.y, back: back(start) };
  const toward = (value: number, goal: number): number => {
    if (value === goal) return value;
    return value < goal ? Math.min(value + step, goal) : Math.max(value - step, goal);
  };

  for (;;) {
    edges.left = toward(edges.left, home.left);
    edges.right = toward(edges.right, home.right);
    edges.front = toward(edges.front, home.front);
    edges.back = toward(edges.back, home.back);
    const atHome =
      edges.left === home.left &&
      edges.right === home.right &&
      edges.front === home.front &&
      edges.back === home.back;
    const rect: SolverRect = {
      x: toUnits(edges.left),
      y: toUnits(edges.front),
      w: toUnits(edges.right - edges.left),
      d: toUnits(edges.back - edges.front),
    };
    if (atHome) return { rect, changes: [], failure: first.failure };
    const attempt = resizeBin(bins, drawer, id, rect, options);
    if (attempt.ok) return { rect, changes: attempt.changes, failure: first.failure };
  }
}
