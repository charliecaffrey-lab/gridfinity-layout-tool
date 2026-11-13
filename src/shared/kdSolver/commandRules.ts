/**
 * Command-bus rules for the Kitchen Drawers solver:
 *  - a locked bin is pinned, so it cannot be moved (upstream only freezes its size);
 *  - in Absorb mode, deleting a bin hands its space to a neighbor.
 */
import { createCommand } from '@/core/cqrs/commands';
import type { Command } from '@/core/cqrs/commands';
import type { DomainEvent } from '@/core/cqrs/events';
import type { CommandResult, NextFn } from '@/core/cqrs/types';
import { STAGING_ID } from '@/core/constants';
import { err, isOk, layoutInvalidOperation } from '@/core/result';
import { useLayoutStore } from '@/core/store/layout';
import { useToastStore } from '@/core/store/toast';
import { kdPinnedMessage, kdPlanAbsorbDeleted } from './editor';

type Dispatch = (command: Command) => CommandResult<unknown, DomainEvent>;
type Rule = (
  command: Command,
  next: NextFn<Command, DomainEvent>
) => CommandResult<unknown, DomainEvent>;

export function createKdCommandRules(dispatch: Dispatch): Rule {
  return function kdCommandRules(command, next) {
    if (command.type === 'bin.update' && command.meta.source === 'user') {
      const { id, updates } = command.payload;
      const bin = useLayoutStore.getState().layout.bins.find((b) => b.id === id);
      const staysLocked = bin?.locked === true && updates.locked !== false;
      const moves =
        bin !== undefined &&
        ((updates.x !== undefined && updates.x !== bin.x) ||
          (updates.y !== undefined && updates.y !== bin.y));
      const onGrid = bin?.layerId !== STAGING_ID && updates.layerId !== STAGING_ID;
      if (bin && staysLocked && moves && onGrid) {
        useToastStore
          .getState()
          .addToast({ message: kdPinnedMessage(bin), type: 'info', key: 'kd-pinned' });
        return err(layoutInvalidOperation('updateBin', `Bin ${id} is pinned`));
      }
    }

    // The Delete key sends a batch even for one bin. Several bins deleted at
    // once leave their gaps: there is no single "neighbor on that side".
    const deletedId =
      command.type === 'bin.delete'
        ? command.payload.id
        : command.type === 'bin.deleteBatch' && command.payload.ids.length === 1
          ? command.payload.ids[0]
          : undefined;
    if (deletedId !== undefined && command.meta.source === 'user') {
      const before = useLayoutStore.getState().layout;
      const deleted = before.bins.find((b) => b.id === deletedId);
      const result = next(command);
      if (isOk(result) && deleted && deleted.layerId !== STAGING_ID) {
        // 'cascade' keeps these inside the delete's own undo step.
        for (const { id, rect } of kdPlanAbsorbDeleted(before, deleted)) {
          dispatch(createCommand('bin.update', { id, updates: rect }, { source: 'cascade' }));
        }
      }
      return result;
    }

    return next(command);
  };
}
