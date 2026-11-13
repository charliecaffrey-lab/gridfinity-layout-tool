import { beforeEach, describe, expect, it } from 'vitest';
import { binId, gridUnits, layerId } from '@/core/types';
import type { Bin, Layout } from '@/core/types';
import { createTestBin, createTestLayout } from '@/test/testUtils';
import {
  KD_MIN_W_KEY,
  kdOrderedUpdates,
  kdPlanAbsorbDeleted,
  kdPlanFill,
  kdPlanResize,
} from './editor';
import { KD_DEFAULT_SETTINGS, useKdSolverSettings } from './settings';

const LAYER = layerId('layer1');

function bin(
  id: string,
  x: number,
  y: number,
  w: number,
  d: number,
  extra: Partial<Bin> = {}
): Bin {
  return createTestBin({
    id: binId(id),
    x: gridUnits(x),
    y: gridUnits(y),
    width: gridUnits(w),
    depth: gridUnits(d),
    ...extra,
  });
}

function layoutOf(bins: Bin[]): Layout {
  return createTestLayout({ bins });
}

const rect = (x: number, y: number, w: number, d: number) => ({
  x: gridUnits(x),
  y: gridUnits(y),
  width: gridUnits(w),
  depth: gridUnits(d),
});

beforeEach(() => {
  useKdSolverSettings.setState({ ...KD_DEFAULT_SETTINGS });
});

describe('kdPlanResize', () => {
  it('Push: plans the neighbor move along with the resize', () => {
    const layout = layoutOf([bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2)]);
    const plan = kdPlanResize({
      layout,
      layerId: LAYER,
      binId: binId('a'),
      requested: rect(0, 0, 3, 2),
      halfGrid: false,
    });
    expect(plan?.rects.get(binId('a'))).toEqual(rect(0, 0, 3, 2));
    expect(plan?.rects.get(binId('b'))).toEqual(rect(3, 0, 2, 2));
    expect(plan?.neighborIds).toEqual([binId('b')]);
    expect(plan?.blockedMessage).toBeUndefined();
  });

  it('Absorb: a shrink hands the freed cells to the neighbor', () => {
    useKdSolverSettings.setState({ freed: 'absorb' });
    const layout = layoutOf([bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2)]);
    const plan = kdPlanResize({
      layout,
      layerId: LAYER,
      binId: binId('a'),
      requested: rect(0, 0, 1, 2),
      halfGrid: false,
    });
    expect(plan?.rects.get(binId('a'))).toEqual(rect(0, 0, 1, 2));
    expect(plan?.rects.get(binId('b'))).toEqual(rect(1, 0, 3, 2));
  });

  it('reports the bin that holds a resize back, using its label', () => {
    const layout = layoutOf([
      bin('a', 0, 0, 2, 2),
      bin('b', 2, 0, 2, 2, { locked: true, label: 'Spice block' }),
    ]);
    const plan = kdPlanResize({
      layout,
      layerId: LAYER,
      binId: binId('a'),
      requested: rect(0, 0, 3, 2),
      halfGrid: false,
    });
    expect(plan?.rects.get(binId('a'))).toEqual(rect(0, 0, 2, 2));
    expect(plan?.blockedMessage).toBe('"Spice block" is pinned and is in the way.');
  });

  it('reads a minimum footprint from the bin custom properties', () => {
    useKdSolverSettings.setState({ mode: 'squeeze' });
    const layout = layoutOf([
      bin('a', 0, 0, 2, 2),
      bin('b', 2, 0, 3, 2, { customProperties: { [KD_MIN_W_KEY]: '3' }, label: 'Whisk' }),
    ]);
    const plan = kdPlanResize({
      layout,
      layerId: LAYER,
      binId: binId('a'),
      requested: rect(0, 0, 3, 2),
      halfGrid: false,
    });
    expect(plan?.rects.get(binId('a'))).toEqual(rect(0, 0, 2, 2));
    expect(plan?.blockedMessage).toContain('"Whisk" can\'t shrink below its minimum size of 3×1');
  });

  it('ignores bins on other layers', () => {
    const layout = layoutOf([
      bin('a', 0, 0, 2, 2),
      bin('elsewhere', 2, 0, 2, 2, { layerId: layerId('__staging__') }),
    ]);
    const plan = kdPlanResize({
      layout,
      layerId: LAYER,
      binId: binId('a'),
      requested: rect(0, 0, 3, 2),
      halfGrid: false,
    });
    expect(plan?.neighborIds).toEqual([]);
  });
});

describe('kdOrderedUpdates', () => {
  it('orders a push so the farthest bin moves first', () => {
    const layout = layoutOf([bin('a', 0, 0, 2, 2), bin('b', 2, 0, 2, 2), bin('c', 4, 0, 2, 2)]);
    const plan = kdPlanResize({
      layout,
      layerId: LAYER,
      binId: binId('a'),
      requested: rect(0, 0, 3, 2),
      halfGrid: false,
    });
    if (!plan) throw new Error('expected a plan');
    expect(kdOrderedUpdates(layout, LAYER, plan.rects).map((u) => u.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('kdPlanAbsorbDeleted', () => {
  const layout = layoutOf([bin('l', 0, 0, 2, 2), bin('gone', 2, 0, 2, 2), bin('r', 4, 0, 2, 2)]);
  const gone = layout.bins[1];

  it('does nothing in Leave gap mode', () => {
    expect(kdPlanAbsorbDeleted(layout, gone)).toEqual([]);
  });

  it('stretches the neighbor across the hole in Absorb mode', () => {
    useKdSolverSettings.setState({ freed: 'absorb' });
    expect(kdPlanAbsorbDeleted(layout, gone)).toEqual([{ id: 'l', rect: rect(0, 0, 4, 2) }]);
  });
});

describe('kdPlanFill', () => {
  it('fills the layer up to the size limit and never overlaps', () => {
    useKdSolverSettings.setState({ fillMaxW: 2, fillMaxD: 2 });
    const layout = layoutOf([bin('a', 0, 0, 2, 2)]);
    const rects = kdPlanFill(layout, LAYER, false);
    const area = rects.reduce((sum, r) => sum + r.width * r.depth, 0);
    expect(area).toBe(10 * 8 - 4);
    expect(rects.every((r) => r.width <= 2 && r.depth <= 2)).toBe(true);
    expect(rects.some((r) => r.x < 2 && r.y < 2)).toBe(false);
  });
});
