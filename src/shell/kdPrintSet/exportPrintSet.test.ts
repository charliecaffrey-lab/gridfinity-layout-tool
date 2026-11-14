import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, useLayoutStore, useSettingsStore } from '@/core/store';
import { binId, designId, gridUnits, heightUnits, layerId } from '@/core/types';
import { createTestBin, createTestLayout, resetAllStores } from '@/test/testUtils';
import type { KdExportPrintSetMessage } from '@/shared/kdEmbed/protocol';
import { isKdParentMessage } from '@/shared/kdEmbed/protocol';
import { kdDefaultParamsFor, kdExportPrintSet, kdGroupUnlinkedBins } from './exportPrintSet';

const bin = (id: string, x: number, w: number, d: number, extra = {}) =>
  createTestBin({
    id: binId(id),
    x: gridUnits(x),
    width: gridUnits(w),
    depth: gridUnits(d),
    height: heightUnits(3),
    ...extra,
  });

const request = (overrides: Partial<KdExportPrintSetMessage> = {}): KdExportPrintSetMessage => ({
  type: 'kd:export-print-set',
  requestId: 'r1',
  baseName: 'kitchen_island_d2',
  format: '3mf',
  bedMm: { w: 330, d: 320 },
  uploadUrl: 'http://kitchen.test/api/print-set?job=abc',
  ...overrides,
});

beforeEach(() => {
  resetAllStores();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
});

describe('protocol: kd:export-print-set', () => {
  it('accepts a well-formed request', () => {
    expect(isKdParentMessage(request())).toBe(true);
  });

  it('rejects unsafe names, odd formats and impossible beds', () => {
    expect(isKdParentMessage(request({ baseName: '../etc/passwd' }))).toBe(false);
    expect(isKdParentMessage(request({ baseName: 'Has Spaces' }))).toBe(false);
    expect(isKdParentMessage({ ...request(), format: 'step' })).toBe(false);
    expect(isKdParentMessage(request({ bedMm: { w: 20, d: 320 } }))).toBe(false);
  });
});

describe('kdGroupUnlinkedBins', () => {
  it('groups same-sized plain bins, skips linked and stashed ones, and keeps half-unit bins apart', () => {
    const layout = createTestLayout({
      bins: [
        bin('a', 0, 2, 2),
        bin('b', 2, 2, 2),
        bin('c', 4, 1, 3),
        bin('linked', 5, 2, 2, { linkedDesignId: designId('design-1') }),
        bin('stashed', 0, 2, 2, { layerId: layerId('__staging__') }),
        bin('half1', 7, 1.5, 1),
        bin('half2', 8.5, 1.5, 1),
      ],
    });
    const groups = kdGroupUnlinkedBins(layout).map((group) => group.map((b) => b.id));
    expect(groups).toEqual([['a', 'b'], ['c'], ['half1'], ['half2']]);
  });
});

describe('kdDefaultParamsFor', () => {
  it("sizes the user's default bin to the layout bin and the layout's grid", () => {
    const layout = createTestLayout({ bins: [bin('a', 0, 3, 2)] });
    const params = kdDefaultParamsFor(layout.bins, layout);
    expect(params).toMatchObject({
      width: 3,
      depth: 2,
      height: 3,
      gridUnitMm: 42,
      heightUnitMm: 7,
    });
  });
});

describe('kdExportPrintSet', () => {
  it('sets the bed, points the upload at the kitchen app for the export only, and reports success', async () => {
    useLayoutStore.setState({ layout: createTestLayout({ bins: [] }) });
    const seen: { url: string; enabled: boolean; bed: number; bedDepth?: number }[] = [];
    const exportLayout = vi.fn(() => {
      const { settings } = useSettingsStore.getState();
      const { layout } = useLayoutStore.getState();
      seen.push({
        url: settings.exportUrl,
        enabled: settings.exportUrlEnabled,
        bed: layout.printBedSize,
        bedDepth: layout.printBedDepth,
      });
      return Promise.resolve(true);
    });

    const result = await kdExportPrintSet(request(), exportLayout);

    expect(result).toEqual({ ok: true, linkedBins: 0 });
    expect(exportLayout).toHaveBeenCalledWith('3mf', 'kitchen_island_d2', {
      style: 'descriptive',
      customName: '',
      format: '3mf',
    });
    expect(seen).toEqual([
      { url: 'http://kitchen.test/api/print-set?job=abc', enabled: true, bed: 330, bedDepth: 320 },
    ]);
    const after = useSettingsStore.getState().settings;
    expect(after.exportUrlEnabled).toBe(false);
    expect(after.exportUrl).toBe('');
  });

  it('restores the settings and explains itself when nothing could be exported', async () => {
    useSettingsStore
      .getState()
      .updateSettings({ exportUrlEnabled: true, exportUrl: 'https://my-nas.test/in' });
    const result = await kdExportPrintSet(request({ format: 'stl' }), () => Promise.resolve(false));
    expect(result).toEqual({
      ok: false,
      linkedBins: 0,
      reason: 'The editor had nothing it could export.',
    });
    const after = useSettingsStore.getState().settings;
    expect(after.exportUrl).toBe('https://my-nas.test/in');
    expect(after.exportUrlEnabled).toBe(true);
  });
});
