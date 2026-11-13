import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommand } from '@/core/cqrs/commands';
import type { Command } from '@/core/cqrs/commands';
import { isErr, ok } from '@/core/result';
import { useLayoutStore } from '@/core/store/layout';
import { binId, gridUnits } from '@/core/types';
import { createTestBin, createTestLayout, resetAllStores } from '@/test/testUtils';
import { createKdCommandRules } from './commandRules';
import { KD_DEFAULT_SETTINGS, useKdSolverSettings } from './settings';

const dispatched: Command[] = [];
const rules = createKdCommandRules((command) => {
  dispatched.push(command);
  return ok({ value: undefined, events: [] });
});
const next = vi.fn(() => ok({ value: undefined, events: [] }));

const bin = (id: string, x: number, locked = false) =>
  createTestBin({
    id: binId(id),
    x: gridUnits(x),
    width: gridUnits(2),
    depth: gridUnits(2),
    locked,
  });

beforeEach(() => {
  resetAllStores();
  dispatched.length = 0;
  next.mockClear();
  useKdSolverSettings.setState({ ...KD_DEFAULT_SETTINGS });
  useLayoutStore.setState({
    layout: createTestLayout({ bins: [bin('l', 0), bin('mid', 2, true), bin('r', 4)] }),
  });
});

describe('pinned bins', () => {
  it('refuses to move a locked bin', () => {
    const result = rules(
      createCommand('bin.update', { id: binId('mid'), updates: { x: gridUnits(6) } }),
      next
    );
    expect(isErr(result)).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets a locked bin be unlocked, relabelled, or sent to the stash', () => {
    for (const updates of [{ locked: false, x: gridUnits(6) }, { label: 'Spices' }]) {
      rules(createCommand('bin.update', { id: binId('mid'), updates }), next);
    }
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('does not interfere with unlocked bins', () => {
    rules(createCommand('bin.update', { id: binId('l'), updates: { x: gridUnits(6) } }), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('absorb on delete', () => {
  it('leaves the gap by default', () => {
    rules(createCommand('bin.delete', { id: binId('r') }), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([]);
  });

  it.each([
    ['bin.delete', { id: binId('l') }],
    ['bin.deleteBatch', { ids: [binId('l')] }],
  ] as const)(
    '%s hands the space to a neighbor as a follow-up that shares the undo step',
    (type, payload) => {
      useKdSolverSettings.setState({ freed: 'absorb' });
      // `mid` is pinned, so it cannot take the space; use a layout where the neighbor is free.
      useLayoutStore.setState({ layout: createTestLayout({ bins: [bin('l', 0), bin('r', 2)] }) });
      rules(createCommand(type, payload as never), next);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: 'bin.update',
        payload: { id: 'r', updates: { x: 0, y: 0, width: 4, depth: 2 } },
        meta: { source: 'cascade' },
      });
    }
  );

  it('a pinned neighbor never absorbs', () => {
    useKdSolverSettings.setState({ freed: 'absorb' });
    rules(createCommand('bin.delete', { id: binId('l') }), next);
    expect(dispatched).toEqual([]);
  });

  it('deleting several bins at once leaves their gaps', () => {
    useKdSolverSettings.setState({ freed: 'absorb' });
    rules(createCommand('bin.deleteBatch', { ids: [binId('l'), binId('r')] }), next);
    expect(dispatched).toEqual([]);
  });
});
