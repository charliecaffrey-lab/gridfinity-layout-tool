import { describe, expect, it } from 'vitest';
import {
  addBin,
  fillGaps,
  moveBin,
  orderChanges,
  removeBin,
  resizeBin,
  resizeBinBestEffort,
} from './solver';
import type { SolverBin, SolverChange, SolverOptions, SolverResult } from './solver';

const drawer = { width: 10, depth: 6 };
const bin = (
  id: string,
  x: number,
  y: number,
  w: number,
  d: number,
  extra: Partial<SolverBin> = {}
): SolverBin => ({
  id,
  x,
  y,
  w,
  d,
  ...extra,
});
const push: SolverOptions = { mode: 'push', freed: 'leaveGap' };
const squeeze: SolverOptions = { mode: 'squeeze', freed: 'leaveGap' };
const fixed: SolverOptions = { mode: 'fixed', freed: 'leaveGap' };

function changesOf(result: SolverResult): Record<string, Omit<SolverChange, 'id'>> {
  if (!result.ok) throw new Error(`expected success, got: ${result.failure.message}`);
  return Object.fromEntries(result.changes.map(({ id, ...rect }) => [id, rect]));
}

function failureOf(result: SolverResult): { code: string; blockerId?: string; message: string } {
  if (result.ok) throw new Error('expected a failure');
  return result.failure;
}

/** Apply changes and assert the layout is still legal: in bounds, no overlaps. */
function applyAndCheck(bins: SolverBin[], changes: SolverChange[], removed?: string): SolverBin[] {
  const next = bins
    .filter((b) => b.id !== removed)
    .map((b) => ({ ...b, ...(changes.find((c) => c.id === b.id) ?? {}) }));
  for (const a of next) {
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(drawer.width);
    expect(a.y + a.d).toBeLessThanOrEqual(drawer.depth);
    for (const b of next) {
      if (a.id >= b.id) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.d <= b.y || b.y + b.d <= a.y;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  }
  return next;
}

describe('resizeBin: Push', () => {
  it('shifts a neighbor over when there is room', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, push);
    expect(changesOf(result)).toEqual({
      a: { x: 0, y: 0, w: 3, d: 2 },
      b: { x: 3, y: 0, w: 2, d: 2 },
    });
  });

  it('pushes a whole chain of neighbors', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2), bin('c', 4, 0, 3, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 4, d: 2 }, push);
    expect(changesOf(result)).toEqual({
      a: { x: 0, y: 0, w: 4, d: 2 },
      b: { x: 4, y: 0, w: 2, d: 2 },
      c: { x: 6, y: 0, w: 3, d: 2 },
    });
  });

  it('only moves neighbors that are actually in the way', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2), bin('other', 2, 3, 2, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, push);
    expect(Object.keys(changesOf(result))).toEqual(['a', 'b']);
  });

  it('uses a gap further along before moving bins beyond it', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2), bin('c', 6, 0, 2, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 4, d: 2 }, push);
    expect(Object.keys(changesOf(result))).toEqual(['a', 'b']);
  });

  it('refuses when the chain would leave the drawer, naming the bin at the wall', () => {
    const bins = [
      bin('a', 0, 0, 4, 2),
      bin('b', 4, 0, 3, 2),
      bin('c', 7, 0, 3, 2, { name: 'Spoons' }),
    ];
    const failure = failureOf(resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 5, d: 2 }, push));
    expect(failure.code).toBe('no_room');
    expect(failure.blockerId).toBe('c');
    expect(failure.message).toBe('There is no room to push "Spoons" any further right.');
  });

  it('pushes left, toward the front, and toward the back', () => {
    const left = resizeBin(
      [bin('a', 4, 0, 2, 2), bin('b', 2, 0, 2, 2)],
      drawer,
      'a',
      { x: 3, y: 0, w: 3, d: 2 },
      push
    );
    expect(changesOf(left).b).toEqual({ x: 1, y: 0, w: 2, d: 2 });
    const backward = resizeBin(
      [bin('a', 0, 0, 2, 2), bin('b', 0, 2, 2, 2)],
      drawer,
      'a',
      { x: 0, y: 0, w: 2, d: 3 },
      push
    );
    expect(changesOf(backward).b).toEqual({ x: 0, y: 3, w: 2, d: 2 });
    const forward = resizeBin(
      [bin('a', 0, 3, 2, 2), bin('b', 0, 1, 2, 2)],
      drawer,
      'a',
      { x: 0, y: 2, w: 2, d: 3 },
      push
    );
    expect(changesOf(forward).b).toEqual({ x: 0, y: 0, w: 2, d: 2 });
  });

  it('growing from a corner pushes one neighbor sideways and another backward', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('side', 2, 0, 2, 2), bin('behind', 0, 2, 2, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 3 }, push);
    const changes = changesOf(result);
    expect(changes.side).toEqual({ x: 3, y: 0, w: 2, d: 2 });
    expect(changes.behind).toEqual({ x: 0, y: 3, w: 2, d: 2 });
    applyAndCheck(bins, result.ok ? result.changes : []);
  });

  it('growing both sides at once pushes each neighbor its own way', () => {
    const bins = [bin('a', 4, 0, 2, 2), bin('l', 2, 0, 2, 2), bin('r', 6, 0, 2, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 3, y: 0, w: 4, d: 2 }, push);
    const changes = changesOf(result);
    expect(changes.l).toEqual({ x: 1, y: 0, w: 2, d: 2 });
    expect(changes.r).toEqual({ x: 7, y: 0, w: 2, d: 2 });
  });
});

describe('resizeBin: Squeeze', () => {
  it('shrinks the neighbor to make room', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 3, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, squeeze);
    expect(changesOf(result).b).toEqual({ x: 3, y: 0, w: 2, d: 2 });
  });

  it('shrinks a neighbor on the left from its right edge', () => {
    const bins = [bin('a', 4, 0, 2, 2), bin('b', 1, 0, 3, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 3, y: 0, w: 3, d: 2 }, squeeze);
    expect(changesOf(result).b).toEqual({ x: 1, y: 0, w: 2, d: 2 });
  });

  it('never squeezes an empty bin below 1 x 1', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 1, 2)];
    const failure = failureOf(resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, squeeze));
    expect(failure.code).toBe('below_minimum');
    expect(failure.blockerId).toBe('b');
  });

  it('never squeezes a bin below the footprint of what it holds, and says which bin', () => {
    const bins = [
      bin('a', 0, 0, 2, 2),
      bin('b', 2, 0, 4, 2, { minW: 3, minD: 2, name: 'Mandoline' }),
    ];
    const ok = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, squeeze);
    expect(changesOf(ok).b).toEqual({ x: 3, y: 0, w: 3, d: 2 });
    const failure = failureOf(resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 4, d: 2 }, squeeze));
    expect(failure.message).toBe('"Mandoline" can\'t shrink below its minimum size of 3×2.');
  });
});

describe('resizeBin: Fixed', () => {
  it('stops at the first neighbor and names it', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2)];
    const failure = failureOf(resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, fixed));
    expect(failure.code).toBe('blocked_by_bin');
    expect(failure.blockerId).toBe('b');
    expect(failure.message).toBe(
      'The 2×2 bin at column 3, row 1 is in the way. Fixed mode stops at the first neighbor.'
    );
  });

  it('still grows into empty space', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 4, 0, 2, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 4, d: 2 }, fixed);
    expect(Object.keys(changesOf(result))).toEqual(['a']);
  });
});

describe('pins', () => {
  it('a pinned bin cannot be resized or moved', () => {
    const bins = [bin('a', 0, 0, 2, 2, { locked: true, name: 'Spice block' })];
    const resized = failureOf(resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, push));
    expect(resized.code).toBe('pinned');
    expect(resized.message).toBe('"Spice block" is pinned. Unpin it to move or resize it.');
    expect(failureOf(moveBin(bins, drawer, 'a', { x: 3, y: 0 })).code).toBe('pinned');
  });

  it.each([push, squeeze])('a pinned neighbor is never pushed or squeezed ($mode)', (options) => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 3, 2, { locked: true })];
    const failure = failureOf(resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, options));
    expect(failure.code).toBe('blocked_by_pinned');
    expect(failure.blockerId).toBe('b');
  });

  it('a pinned bin stops a push chain behind it', () => {
    const bins = [
      bin('a', 0, 0, 2, 2),
      bin('b', 2, 0, 2, 2),
      bin('c', 4, 0, 2, 2, { locked: true }),
    ];
    const failure = failureOf(resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, push));
    expect(failure.blockerId).toBe('c');
  });

  it('a pinned bin never absorbs freed space', () => {
    const bins = [bin('a', 0, 0, 4, 2), bin('b', 4, 0, 2, 2, { locked: true })];
    const result = resizeBin(
      bins,
      drawer,
      'a',
      { x: 0, y: 0, w: 2, d: 2 },
      { mode: 'push', freed: 'absorb' }
    );
    expect(Object.keys(changesOf(result))).toEqual(['a']);
  });
});

describe('minimum size of the bin being resized', () => {
  it('cannot shrink below what its contents need', () => {
    const bins = [bin('a', 0, 0, 4, 3, { minW: 3, minD: 2, name: 'Whisk' })];
    const failure = failureOf(resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 2, d: 3 }, push));
    expect(failure.code).toBe('below_minimum');
    expect(failure.message).toBe(
      '"Whisk" can\'t be smaller than 3×2, the space its contents need.'
    );
  });

  it('an empty bin can shrink to 1 x 1, and to a half unit only if it already was one', () => {
    const half = { ...push, step: 0.5 };
    expect(
      resizeBin([bin('a', 0, 0, 2, 2)], drawer, 'a', { x: 0, y: 0, w: 1, d: 1 }, half).ok
    ).toBe(true);
    expect(
      resizeBin([bin('a', 0, 0, 2, 2)], drawer, 'a', { x: 0, y: 0, w: 0.5, d: 1 }, half).ok
    ).toBe(false);
    expect(
      resizeBin([bin('a', 0, 0, 0.5, 2)], drawer, 'a', { x: 0, y: 0, w: 0.5, d: 1 }, half).ok
    ).toBe(true);
  });
});

describe('freed space', () => {
  const absorb: SolverOptions = { mode: 'push', freed: 'absorb' };

  it('Leave gap: a shrink changes only the bin itself', () => {
    const bins = [bin('a', 0, 0, 4, 2), bin('b', 4, 0, 2, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 2, d: 2 }, push);
    expect(Object.keys(changesOf(result))).toEqual(['a']);
  });

  it('Absorb: the neighbor on the shrinking side takes the space', () => {
    const bins = [bin('a', 0, 0, 4, 2), bin('b', 4, 0, 2, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 2, d: 2 }, absorb);
    expect(changesOf(result).b).toEqual({ x: 2, y: 0, w: 4, d: 2 });
  });

  it('Absorb: two neighbors stacked on that side both stretch', () => {
    const bins = [bin('a', 0, 0, 4, 4), bin('b', 4, 0, 2, 2), bin('c', 4, 2, 2, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 4 }, absorb);
    const changes = changesOf(result);
    expect(changes.b).toEqual({ x: 3, y: 0, w: 3, d: 2 });
    expect(changes.c).toEqual({ x: 3, y: 2, w: 3, d: 2 });
  });

  it('Absorb: a neighbor that sticks out past the bin cannot take the space', () => {
    const bins = [bin('a', 0, 0, 4, 2), bin('tall', 4, 0, 2, 4)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 2, d: 2 }, absorb);
    expect(Object.keys(changesOf(result))).toEqual(['a']);
  });

  it('Absorb: shrinking from the back hands the space to the bin behind', () => {
    const bins = [bin('a', 0, 0, 3, 4), bin('b', 0, 4, 3, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, absorb);
    expect(changesOf(result).b).toEqual({ x: 0, y: 2, w: 3, d: 4 });
  });

  it('Absorb: shrinking a corner never produces an overlap', () => {
    const bins = [bin('a', 0, 0, 4, 4), bin('r', 4, 0, 2, 4), bin('b', 0, 4, 4, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 2, d: 2 }, absorb);
    applyAndCheck(bins, result.ok ? result.changes : []);
    expect(result.ok).toBe(true);
  });
});

describe('removeBin', () => {
  it('Leave gap: nothing else changes', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2)];
    expect(changesOf(removeBin(bins, drawer, 'a', { freed: 'leaveGap' }))).toEqual({});
  });

  it('Absorb: the side that covers the most of the hole takes it', () => {
    const bins = [bin('gone', 2, 0, 4, 2), bin('small', 0, 0, 2, 1), bin('full', 6, 0, 2, 2)];
    const result = removeBin(bins, drawer, 'gone', { freed: 'absorb' });
    expect(changesOf(result)).toEqual({ full: { x: 2, y: 0, w: 6, d: 2 } });
    applyAndCheck(bins, result.ok ? result.changes : [], 'gone');
  });

  it('Absorb: an equal tie goes to the left neighbor', () => {
    const bins = [bin('gone', 2, 0, 2, 2), bin('l', 0, 0, 2, 2), bin('r', 4, 0, 2, 2)];
    expect(changesOf(removeBin(bins, drawer, 'gone', { freed: 'absorb' }))).toEqual({
      l: { x: 0, y: 0, w: 4, d: 2 },
    });
  });

  it('Absorb: with no neighbor that fits, the hole stays', () => {
    const bins = [bin('gone', 0, 0, 2, 2), bin('tall', 2, 0, 2, 4)];
    expect(changesOf(removeBin(bins, drawer, 'gone', { freed: 'absorb' }))).toEqual({});
  });
});

describe('moveBin and addBin', () => {
  const bins = [bin('a', 0, 0, 2, 2), bin('b', 4, 0, 2, 2, { name: 'Tongs' })];

  it('moves into free space', () => {
    expect(changesOf(moveBin(bins, drawer, 'a', { x: 2, y: 0 }))).toEqual({
      a: { x: 2, y: 0, w: 2, d: 2 },
    });
  });

  it('refuses to overlap and names the blocker', () => {
    const failure = failureOf(moveBin(bins, drawer, 'a', { x: 3, y: 0 }));
    expect(failure.blockerId).toBe('b');
    expect(failure.message).toBe('"Tongs" is in the way.');
  });

  it('refuses to leave the drawer or sit off the grid', () => {
    expect(failureOf(moveBin(bins, drawer, 'a', { x: 9, y: 0 })).code).toBe('out_of_bounds');
    expect(failureOf(moveBin(bins, drawer, 'a', { x: 0.5, y: 0 })).code).toBe('off_grid');
    expect(moveBin(bins, drawer, 'a', { x: 0.5, y: 0 }, { step: 0.5 }).ok).toBe(true);
  });

  it('adding checks bounds and overlap', () => {
    expect(addBin(bins, drawer, bin('n', 2, 0, 2, 2)).ok).toBe(true);
    expect(failureOf(addBin(bins, drawer, bin('n', 3, 0, 2, 2))).blockerId).toBe('b');
    expect(failureOf(addBin(bins, drawer, bin('n', 9, 5, 2, 2))).code).toBe('out_of_bounds');
  });
});

describe('fillGaps', () => {
  it('fills an empty drawer with the largest bins the limit allows', () => {
    const placed = fillGaps([], { width: 6, depth: 4 }, { maxW: 3, maxD: 4 });
    expect(placed).toEqual([
      { x: 0, y: 0, w: 3, d: 4 },
      { x: 3, y: 0, w: 3, d: 4 },
    ]);
  });

  it('works around existing bins and leaves no empty cell', () => {
    const existing = [bin('a', 0, 0, 2, 2), bin('b', 5, 3, 3, 3)];
    const placed = fillGaps(existing, drawer, { maxW: 4, maxD: 4 });
    const all = [...existing, ...placed.map((r, i) => bin(`f${i}`, r.x, r.y, r.w, r.d))];
    applyAndCheck(all, []);
    const area = all.reduce((sum, b) => sum + b.w * b.d, 0);
    expect(area).toBe(drawer.width * drawer.depth);
    for (const r of placed) {
      expect(r.w).toBeLessThanOrEqual(4);
      expect(r.d).toBeLessThanOrEqual(4);
    }
  });

  it('respects a caller rule about where bins may go', () => {
    const placed = fillGaps(
      [],
      { width: 4, depth: 2 },
      { maxW: 4, maxD: 2, allowed: (r) => r.x + r.w <= 2 }
    );
    expect(placed).toEqual([{ x: 0, y: 0, w: 2, d: 2 }]);
  });

  it('fills half-unit slivers in half-grid mode', () => {
    const placed = fillGaps(
      [bin('a', 0, 0, 2, 1)],
      { width: 2.5, depth: 1 },
      { maxW: 4, maxD: 4, step: 0.5 }
    );
    expect(placed).toEqual([{ x: 2, y: 0, w: 0.5, d: 1 }]);
  });

  it('gives the same answer every time', () => {
    const existing = [bin('a', 3, 1, 2, 2)];
    const first = fillGaps(existing, drawer, { maxW: 3, maxD: 3 });
    expect(fillGaps(existing, drawer, { maxW: 3, maxD: 3 })).toEqual(first);
  });
});

describe('orderChanges', () => {
  it('moves the farthest bin first so each step is legal by itself', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2), bin('c', 4, 0, 3, 2)];
    const result = resizeBin(bins, drawer, 'a', { x: 0, y: 0, w: 4, d: 2 }, push);
    if (!result.ok) throw new Error('expected success');
    const ordered = orderChanges(bins, result.changes);
    expect(ordered.map((c) => c.id)).toEqual(['c', 'b', 'a']);
    let state = bins;
    for (const change of ordered) state = applyAndCheck(state, [change]);
  });

  it('shrinks before a neighbor absorbs', () => {
    const bins = [bin('a', 0, 0, 4, 2), bin('b', 4, 0, 2, 2)];
    const result = resizeBin(
      bins,
      drawer,
      'a',
      { x: 0, y: 0, w: 2, d: 2 },
      { mode: 'push', freed: 'absorb' }
    );
    if (!result.ok) throw new Error('expected success');
    expect(orderChanges(bins, result.changes).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('resizeBinBestEffort', () => {
  it('returns the full request when it fits', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2)];
    const result = resizeBinBestEffort(bins, drawer, 'a', { x: 0, y: 0, w: 3, d: 2 }, push);
    expect(result.rect).toEqual({ x: 0, y: 0, w: 3, d: 2 });
    expect(result.failure).toBeUndefined();
  });

  it('goes as far as it can and reports what stopped it', () => {
    const bins = [
      bin('a', 0, 0, 2, 2),
      bin('b', 2, 0, 2, 2),
      bin('wall', 8, 0, 2, 2, { locked: true }),
    ];
    const result = resizeBinBestEffort(bins, drawer, 'a', { x: 0, y: 0, w: 9, d: 2 }, push);
    expect(result.rect).toEqual({ x: 0, y: 0, w: 6, d: 2 });
    expect(result.changes.find((c) => c.id === 'b')).toEqual({ id: 'b', x: 6, y: 0, w: 2, d: 2 });
    expect(result.failure?.blockerId).toBe('wall');
    applyAndCheck(bins, result.changes);
  });

  it('stays put, with the reason, when nothing is possible', () => {
    const bins = [bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2, { locked: true })];
    const result = resizeBinBestEffort(bins, drawer, 'a', { x: 0, y: 0, w: 4, d: 2 }, push);
    expect(result.rect).toEqual({ x: 0, y: 0, w: 2, d: 2 });
    expect(result.changes).toEqual([]);
    expect(result.failure?.code).toBe('blocked_by_pinned');
  });

  it('stops shrinking at the minimum size', () => {
    const bins = [bin('a', 0, 0, 5, 2, { minW: 3, minD: 1 })];
    const result = resizeBinBestEffort(bins, drawer, 'a', { x: 0, y: 0, w: 1, d: 2 }, push);
    expect(result.rect).toEqual({ x: 0, y: 0, w: 3, d: 2 });
    expect(result.failure?.code).toBe('below_minimum');
  });
});

describe('every result is a legal layout', () => {
  const bins = [
    bin('a', 0, 0, 3, 2),
    bin('b', 3, 0, 2, 2),
    bin('c', 5, 0, 2, 3),
    bin('d', 0, 2, 2, 2),
    bin('e', 2, 2, 3, 2, { locked: true }),
    bin('f', 7, 0, 3, 2, { minW: 2 }),
    bin('g', 0, 4, 4, 2),
  ];
  const modes: SolverOptions[] = [
    push,
    squeeze,
    fixed,
    { mode: 'push', freed: 'absorb' },
    { mode: 'squeeze', freed: 'absorb' },
  ];

  it('across every bin, every reachable rectangle and every mode', () => {
    let successes = 0;
    for (const options of modes) {
      for (const target of bins) {
        for (let x = 0; x <= target.x; x++) {
          for (let y = 0; y <= target.y; y++) {
            for (let w = 1; x + w <= drawer.width; w += 2) {
              for (let d = 1; y + d <= drawer.depth; d += 2) {
                const result = resizeBin(bins, drawer, target.id, { x, y, w, d }, options);
                if (!result.ok) {
                  expect(result.failure.message.length).toBeGreaterThan(10);
                  continue;
                }
                successes++;
                const after = applyAndCheck(bins, result.changes);
                const pinned = after.find((b) => b.id === 'e');
                expect(pinned).toMatchObject({ x: 2, y: 2, w: 3, d: 2 });
                expect(after.find((b) => b.id === 'f')?.w).toBeGreaterThanOrEqual(2);
                let state = bins;
                for (const change of orderChanges(bins, result.changes)) {
                  state = applyAndCheck(state, [change]);
                }
              }
            }
          }
        }
      }
    }
    expect(successes).toBeGreaterThan(100);
  });
});
