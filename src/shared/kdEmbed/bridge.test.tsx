import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportLayoutJSON } from '@/core/storage';
import { useLayoutStore } from '@/core/store';
import { binId, gridUnits } from '@/core/types';
import { createTestBin, createTestLayout, resetAllStores } from '@/test/testUtils';
import { kdLayoutFromMessage, startKdEmbedBridge } from './bridge';
import { isKdParentMessage, readKdParentOrigin } from './protocol';
import type { KdLoadMessage } from './protocol';

const load = (overrides: Partial<KdLoadMessage> = {}): KdLoadMessage => ({
  type: 'kd:load',
  drawerId: 'drawer-1',
  name: 'Island - Spice drawer',
  interiorMm: { w: 410, d: 550, h: 65 },
  layoutJson: null,
  ...overrides,
});

beforeEach(() => {
  resetAllStores();
});

describe('protocol', () => {
  it('reads the parent origin only when the embed flag is set', () => {
    expect(readKdParentOrigin('?kd=1&kdParent=http%3A%2F%2Ffamilydashboard%3A3061')).toBe(
      'http://familydashboard:3061'
    );
    expect(readKdParentOrigin('?kdParent=http%3A%2F%2Fx.test')).toBeNull();
    expect(readKdParentOrigin('?kd=1')).toBeNull();
    expect(readKdParentOrigin('?kd=1&kdParent=javascript%3Aalert(1)')).toBeNull();
    expect(readKdParentOrigin('?drawer=300x400')).toBeNull();
  });

  it('accepts well-formed parent messages and rejects the rest', () => {
    expect(isKdParentMessage(load())).toBe(true);
    expect(isKdParentMessage({ type: 'kd:get-layout', requestId: 'r1' })).toBe(true);
    expect(isKdParentMessage({ type: 'kd:get-layout' })).toBe(false);
    expect(isKdParentMessage(load({ interiorMm: { w: 0, d: 550, h: 65 } }))).toBe(false);
    expect(isKdParentMessage({ ...load(), layoutJson: 5 })).toBe(false);
    expect(isKdParentMessage(load({ bedMm: { w: 330, d: 320 } }))).toBe(true);
    expect(isKdParentMessage(load({ bedMm: { w: 330, d: 5 } }))).toBe(false);
    expect(isKdParentMessage({ ...load(), bedMm: 'a2l' })).toBe(false);
    expect(isKdParentMessage('kd:load')).toBe(false);
    expect(isKdParentMessage(null)).toBe(false);
  });
});

describe('kdLayoutFromMessage', () => {
  it('builds a blank layout sized to the measured drawer', async () => {
    const layout = await kdLayoutFromMessage(load());
    if (typeof layout === 'string') throw new Error(layout);
    expect(layout.name).toBe('Island - Spice drawer');
    expect(layout.drawer.width).toBe(9);
    expect(layout.drawer.depth).toBe(13);
    expect(layout.drawer.measuredMm).toMatchObject({ width: 410, depth: 550, height: 65 });
    expect(layout.bins).toEqual([]);
  });

  it('keeps bin ids when reopening a saved layout', async () => {
    const saved = createTestLayout({
      bins: [createTestBin({ id: binId('spice-block'), width: gridUnits(2), depth: gridUnits(3) })],
    });
    const layout = await kdLayoutFromMessage(load({ layoutJson: exportLayoutJSON(saved) }));
    if (typeof layout === 'string') throw new Error(layout);
    expect(layout.bins.map((b) => b.id)).toEqual(['spice-block']);
    expect(layout.layers[0].id).toBe(saved.layers[0].id);
    expect(layout.name).toBe('Island - Spice drawer');
    expect('_meta' in layout).toBe(false);
  });

  it("opens a new or a saved drawer set to the chosen printer's bed", async () => {
    const fresh = await kdLayoutFromMessage(load({ bedMm: { w: 330, d: 320 } }));
    if (typeof fresh === 'string') throw new Error(fresh);
    expect([fresh.printBedSize, fresh.printBedDepth]).toEqual([330, 320]);

    const saved = createTestLayout({ bins: [createTestBin({ id: binId('spice-block') })] });
    const reopened = await kdLayoutFromMessage(
      load({ layoutJson: exportLayoutJSON(saved), bedMm: { w: 330, d: 320 } })
    );
    if (typeof reopened === 'string') throw new Error(reopened);
    expect([reopened.printBedSize, reopened.printBedDepth]).toEqual([330, 320]);
    expect(reopened.bins.map((b) => b.id)).toEqual(['spice-block']);

    const untouched = await kdLayoutFromMessage(load({ layoutJson: exportLayoutJSON(saved) }));
    if (typeof untouched === 'string') throw new Error(untouched);
    expect(untouched.printBedSize).toBe(saved.printBedSize);
  });

  it('explains a layout it cannot read, or a drawer too small for the grid', async () => {
    expect(await kdLayoutFromMessage(load({ layoutJson: '{not json' }))).toBe(
      'The saved layout is not valid JSON.'
    );
    expect(typeof (await kdLayoutFromMessage(load({ layoutJson: '{"bins": 3}' })))).toBe('string');
    expect(await kdLayoutFromMessage(load({ interiorMm: { w: 20, d: 550, h: 65 } }))).toBe(
      'That drawer is too small or too large for a Gridfinity grid.'
    );
  });
});

describe('startKdEmbedBridge', () => {
  const ORIGIN = 'http://kitchen.test';
  let stop: (() => void) | undefined;
  const sent: unknown[] = [];
  const parent = {
    postMessage: (message: unknown, target: string) => sent.push({ message, target }),
  } as unknown as Window;
  const deliver = (data: unknown, origin = ORIGIN, source: unknown = parent): void => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }));
  };

  beforeEach(() => {
    sent.length = 0;
    stop = startKdEmbedBridge(ORIGIN, parent);
  });
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it('announces itself to the parent origin only', () => {
    expect(sent).toEqual([{ message: { type: 'kd:ready' }, target: ORIGIN }]);
  });

  it('ignores messages from another origin or another window', () => {
    deliver({ type: 'kd:get-layout', requestId: 'r1' }, 'http://evil.test');
    deliver({ type: 'kd:get-layout', requestId: 'r2' }, ORIGIN, {});
    expect(sent).toHaveLength(1);
  });

  it('refuses to hand back a layout before a drawer is loaded', () => {
    deliver({ type: 'kd:get-layout', requestId: 'r1' });
    expect(sent[1]).toEqual({
      message: { type: 'kd:layout-failed', requestId: 'r1', reason: 'No drawer is loaded yet.' },
      target: ORIGIN,
    });
  });

  it('stays quiet about layout changes until a drawer is loaded', () => {
    vi.useFakeTimers();
    useLayoutStore.setState({ layout: createTestLayout({ name: 'changed' }) });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
  });
});
