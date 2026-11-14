/**
 * Kitchen Drawers fork: apply a set of bin changes sent by the kitchen app (a
 * layout Claude proposed and the person accepted). The kitchen app has already
 * run the plan through the layout solver; here every change still goes through
 * the editor's own commands, so a plan that does not fit is refused piece by
 * piece rather than forced in. The whole set is one undo step.
 */
import { STAGING_ID } from '@/core/constants';
import { batch, commandBus, createCommand } from '@/core/cqrs';
import { isOk } from '@/core/result';
import { useLayoutStore, useSelectionStore } from '@/core/store';
import type { Bin, GridUnits, HeightUnits } from '@/core/types';
import type { KdApplyBinsResult } from '@/shared/kdEmbed/bridge';
import type { KdApplyBinsMessage } from '@/shared/kdEmbed/protocol';
import { KD_MIN_D_KEY, KD_MIN_W_KEY, kdOrderedUpdates } from '@/shared/kdSolver/editor';
import { KD_ITEM_ID_KEY } from '@/shell/kdFitted/addFittedBin';

export function kdApplyBins(message: KdApplyBinsMessage): KdApplyBinsResult {
  const before = useLayoutStore.getState().layout;
  const selection = useSelectionStore.getState();
  const layer = before.layers.find((l) => l.id === selection.activeLayerId) ?? before.layers[0];
  const category =
    before.categories.find((c) => c.id === selection.activeCategoryId) ?? before.categories[0];
  const failed: string[] = [];
  const added: { index: number; binId: string }[] = [];
  const nameOf = (id: string): string => {
    const bin = before.bins.find((b) => b.id === id);
    return bin?.label ? `"${bin.label}"` : 'a bin';
  };

  batch(() => {
    for (const id of message.remove) {
      const bin = before.bins.find((b) => b.id === id);
      if (!bin || bin.layerId === STAGING_ID) continue;
      // 'cascade' keeps the Absorb rule out of it: the plan already says where everything goes.
      const removed = commandBus.dispatch(
        createCommand('bin.delete', { id: bin.id }, { source: 'cascade' })
      );
      if (!isOk(removed)) {
        failed.push(`Could not remove ${nameOf(id)}.`);
      }
    }

    // Moves and resizes go in an order where each is legal by itself.
    const current = useLayoutStore.getState().layout;
    const rects = new Map(
      message.update.flatMap((change) => {
        const bin = current.bins.find((b) => b.id === change.id);
        return bin
          ? [
              [
                bin.id,
                {
                  x: change.x as GridUnits,
                  y: change.y as GridUnits,
                  width: change.w as GridUnits,
                  depth: change.d as GridUnits,
                },
              ] as const,
            ]
          : [];
      })
    );
    for (const { id, rect } of kdOrderedUpdates(current, layer.id, rects)) {
      if (!isOk(commandBus.dispatch(createCommand('bin.update', { id, updates: rect })))) {
        failed.push(`Could not move or resize ${nameOf(id)}.`);
      }
    }
    for (const change of message.update) {
      if (change.label === undefined) continue;
      const bin = current.bins.find((b) => b.id === change.id);
      if (!bin) continue;
      commandBus.dispatch(
        createCommand('bin.update', { id: bin.id, updates: { label: change.label.slice(0, 24) } })
      );
    }

    message.add.forEach((spec, index) => {
      const bin: Omit<Bin, 'id'> = {
        layerId: layer.id,
        x: spec.x as GridUnits,
        y: spec.y as GridUnits,
        width: spec.w as GridUnits,
        depth: spec.d as GridUnits,
        height: spec.h as HeightUnits,
        category: category.id,
        label: spec.label.slice(0, 24),
        notes: '',
        ...(spec.itemId !== undefined
          ? {
              items: [
                {
                  id: spec.itemId.slice(0, 64),
                  name: (spec.itemName ?? spec.label).slice(0, 48),
                  qty: 1,
                },
              ],
              customProperties: {
                [KD_ITEM_ID_KEY]: spec.itemId,
                ...(spec.minW !== undefined ? { [KD_MIN_W_KEY]: String(spec.minW) } : {}),
                ...(spec.minD !== undefined ? { [KD_MIN_D_KEY]: String(spec.minD) } : {}),
              },
            }
          : {}),
      };
      const result = commandBus.dispatch(createCommand('bin.add', bin));
      if (isOk(result)) added.push({ index, binId: String(result.value.value) });
      else failed.push(`Could not add "${spec.label}" (${spec.w}×${spec.d}).`);
    });
  });

  return { ok: true, added, failed };
}
