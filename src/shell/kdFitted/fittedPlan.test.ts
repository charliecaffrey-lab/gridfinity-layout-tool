import { describe, expect, it } from 'vitest';
import { binId, gridUnits, heightUnits, layerId } from '@/core/types';
import { DEFAULT_BIN_PARAMS } from '@/features/bin-designer/constants/defaults';
import { getInteriorDims } from '@/features/bin-designer/utils/dividerAngle';
import { isKdParentMessage } from '@/shared/kdEmbed/protocol';
import type { KdAddFittedBinMessage } from '@/shared/kdEmbed/protocol';
import { createTestBin, createTestLayout } from '@/test/testUtils';
import { kdFindFreeSpot } from './addFittedBin';
import { kdPlanFittedBin } from './fittedPlan';
import type { FittedPlan } from './fittedPlan';

const grid = { gridUnitMm: 42, heightUnitMm: 7, drawerHeightUnits: 9 };

const request = (
  item: Partial<KdAddFittedBinMessage['item']> = {},
  rest: Partial<KdAddFittedBinMessage> = {}
): KdAddFittedBinMessage => ({
  type: 'kd:add-fitted-bin',
  requestId: 'r1',
  item: {
    id: 'item-1',
    name: 'Mandoline',
    shape: 'rect',
    lengthMm: 100,
    widthMm: 60,
    heightMm: 30,
    ...item,
  },
  clearanceMm: 0.5,
  pocketDepthMm: 20,
  fingerNotch: false,
  ...rest,
});

const plan = (message: KdAddFittedBinMessage): FittedPlan => {
  const result = kdPlanFittedBin(message, DEFAULT_BIN_PARAMS, grid);
  if (typeof result === 'string') throw new Error(result);
  return result;
};

describe('protocol: kd:add-fitted-bin', () => {
  it('accepts a well-formed request and rejects bad sizes and shapes', () => {
    expect(isKdParentMessage(request())).toBe(true);
    expect(isKdParentMessage(request({ lengthMm: 0 }))).toBe(false);
    expect(isKdParentMessage(request({ shape: 'star' as never }))).toBe(false);
    expect(isKdParentMessage(request({ outline: [{ x: 0, y: Number.NaN }] }))).toBe(false);
  });
});

describe('kdPlanFittedBin', () => {
  it('picks the smallest bin whose inside holds the pocket, clearance and margin', () => {
    const p = plan(request());
    expect(p.units).toEqual({ w: 3, d: 2, h: 4 });
    expect(p.params.style).toBe('solid');
    expect(p.params.base.solid).toBe(true);
    const { innerW, innerD } = getInteriorDims(p.params);
    expect(innerW).toBeGreaterThanOrEqual(100 + 1 + 4);
    expect(innerD).toBeGreaterThanOrEqual(60 + 1 + 4);
    // One size smaller would not fit.
    expect(getInteriorDims({ ...p.params, width: 2 }).innerW).toBeLessThan(105);
  });

  it('centres a rectangular pocket and gives it the asked depth and clearance', () => {
    const p = plan(request());
    const [pocket] = p.params.cutouts;
    const { innerW, innerD } = getInteriorDims(p.params);
    expect(pocket).toMatchObject({
      shape: 'rectangle',
      width: 100,
      depth: 60,
      cutDepth: 20,
      clearance: 0.5,
    });
    expect(pocket.x).toBeCloseTo((innerW - 100) / 2);
    expect(pocket.y).toBeCloseTo((innerD - 60) / 2);
    expect(p.params.cutouts).toHaveLength(1);
  });

  it('makes a round pocket from the diameter', () => {
    const p = plan(request({ shape: 'round', lengthMm: 70, widthMm: 70 }));
    expect(p.params.cutouts[0]).toMatchObject({ shape: 'circle', width: 70 });
    expect(p.units.w).toBe(p.units.d);
  });

  it('cuts a stepped pocket with a shallower right-hand part', () => {
    const p = plan(request({ shape: 'stepped', step: { deepLengthMm: 40, shallowDepthMm: 8 } }));
    expect(p.params.cutouts[0].split).toEqual({
      a: { x: -10, y: -31 },
      b: { x: -10, y: 31 },
      cutDepth: 8,
    });
    expect(p.params.cutouts[0].cutDepth).toBe(20);
  });

  it('turns a traced outline into a path pocket placed inside the bin, without repeated points', () => {
    const outline = [
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 40 },
      { x: 50, y: 55 },
      { x: 10, y: 40 },
      { x: 10, y: 10 },
    ];
    const p = plan(request({ shape: 'outline', outline }));
    const [pocket] = p.params.cutouts;
    expect(pocket.shape).toBe('path');
    expect(pocket.width).toBe(80);
    expect(pocket.depth).toBe(45);
    expect(pocket.path).toHaveLength(5);
    const xs = (pocket.path ?? []).map((point) => point.x);
    expect(Math.min(...xs)).toBeCloseTo(pocket.x);
    expect(Math.max(...xs)).toBeCloseTo(pocket.x + 80);
  });

  it('adds a finger notch at the back edge and makes room for it', () => {
    const without = plan(request({ widthMm: 74 }));
    const withNotch = plan(request({ widthMm: 74 }, { fingerNotch: true }));
    expect(withNotch.params.cutouts).toHaveLength(2);
    expect(withNotch.params.cutouts[1]).toMatchObject({
      shape: 'circle',
      finger: { bottom: 'curved' },
    });
    expect(withNotch.units.d).toBeGreaterThan(without.units.d);
  });

  it('keeps the pocket within what a low drawer allows, and says so', () => {
    const result = kdPlanFittedBin(request({}, { pocketDepthMm: 40 }), DEFAULT_BIN_PARAMS, {
      ...grid,
      drawerHeightUnits: 4,
    });
    if (typeof result === 'string') throw new Error(result);
    expect(result.units.h).toBe(4);
    expect(result.pocketDepthMm).toBe(20);
    expect(result.notes[0]).toContain('20.0 mm deep instead of 40.0 mm');
  });

  it('refuses an item too large for any bin', () => {
    expect(kdPlanFittedBin(request({ lengthMm: 900 }), DEFAULT_BIN_PARAMS, grid)).toBe(
      'That item needs a bin larger than 12×12 grid units.'
    );
  });
});

describe('kdFindFreeSpot', () => {
  const layer = layerId('layer1');
  const filled = createTestBin({
    id: binId('a'),
    width: gridUnits(8),
    depth: gridUnits(8),
    height: heightUnits(3),
  });

  it('finds the first free spot scanning front to back, left to right', () => {
    const layout = createTestLayout({ bins: [filled] });
    expect(kdFindFreeSpot(layout, layer, { w: 2, d: 3, h: 3 })).toEqual({ x: 8, y: 0 });
  });

  it('returns nothing when the bin cannot fit anywhere', () => {
    const layout = createTestLayout({ bins: [filled] });
    expect(kdFindFreeSpot(layout, layer, { w: 3, d: 3, h: 3 })).toBeNull();
  });
});
