import { useCallback } from 'react';
import { useInteractionStore, useHalfGridModeStore, useToastStore } from '@/core/store';
import { canPlaceBin, getPlacementErrorMessage } from '@/shared/utils/validation';
import { snapResizeRect } from '@/shared/utils/snap';
import { calculateResizeRect, capturePointer } from './interaction';
import { findBinById } from '@/shared/utils/entity';
import { isBinLocked } from '@/shared/utils/binLocation';
import { mlTracking } from '@/shared/analytics/useMLTracking';
import { emitSyncEvent } from '@/shared/events/syncEventBus';
import { useTranslation } from '@/i18n';
import {
  kdOrderedUpdates,
  kdPlanResize,
  kdSetBlockedMessage,
  kdTakeBlockedMessage,
} from '@/shared/kdSolver/editor';
import type { InteractionContext, ModeHandlers, ResizeStartArgs } from './types';
import type { BinId, Coord, Rect, ValidationReason, BlockingInfo } from '@/core/types';

/**
 * Hook for resize mode interactions: resizing bins via corner/edge handles.
 *
 * ## Features
 *
 * - **Multi-bin resizing**: When resizing a selected bin, all selected bins resize together
 * - **Handle-aware**: Resizes from the handle being dragged (corners and edges)
 * - **Proportional**: All bins in group resize by the same delta
 * - **Half-bin aware**: Supports 0.5 unit increments when half-bin mode is enabled
 *
 * ## Validation
 *
 * - Throttled via RAF (handled by parent) due to heavy collision detection
 * - Validates all bins in group against collisions and bounds
 * - Invalid positions shown visually but not committed
 *
 * @param context - Shared interaction context from parent hook
 * @returns ModeHandlers for resize interactions
 */
export function useResizeInteraction(context: InteractionContext): ModeHandlers<ResizeStartArgs> {
  const t = useTranslation();
  const addToast = useToastStore((state) => state.addToast);
  const {
    layout,
    activeLayerId,
    selectedBinIds,
    setInteraction,
    setSelectedBin,
    updateBin,
    execute,
    activePointerIdRef,
    capturedPointerRef,
    ctrlKeyRef,
  } = context;

  /**
   * Start resizing bin(s).
   * @param binId - ID of the bin being resized
   * @param handle - Which resize handle is being dragged
   * @param pointerId - Pointer ID for capture
   */
  const start = useCallback(
    (binId: BinId, handle: ResizeStartArgs[1], pointerId?: number) => {
      const bin = findBinById(layout, binId);
      if (!bin || isBinLocked(bin)) return;

      // Capture pointer at document level for reliable event delivery
      capturePointer(pointerId, activePointerIdRef, capturedPointerRef);

      // If clicked bin is in selection, resize all selected bins. Locked bins
      // drop out of the group rather than blocking it — the rest still resize,
      // and `bin.update` would reject them anyway.
      let binIds: BinId[];
      if (selectedBinIds.includes(binId)) {
        binIds = selectedBinIds.filter((id) => {
          const selected = findBinById(layout, id);
          return selected !== undefined && !isBinLocked(selected);
        });
      } else {
        binIds = [binId];
        setSelectedBin(binId);
      }

      // Store start rects for all bins being resized
      const startRects = new Map<BinId, Rect>();
      const currentRects = new Map<BinId, Rect>();
      for (const id of binIds) {
        const b = findBinById(layout, id);
        if (b) {
          const rect = { x: b.x, y: b.y, width: b.width, depth: b.depth };
          startRects.set(id, rect);
          currentRects.set(id, { ...rect });
        }
      }

      setInteraction({
        type: 'resize',
        binIds,
        handle,
        startRects,
        currentRects,
        valid: true,
      });
    },
    [layout, selectedBinIds, setSelectedBin, setInteraction, activePointerIdRef, capturedPointerRef]
  );

  /**
   * Handle pointer movement during resize.
   * Calculates new rects and validates placement.
   * NOTE: This is throttled via RAF by the parent hook.
   */
  const handleMove = useCallback(
    (_coords: Coord, clamped: Coord) => {
      const interaction = useInteractionStore.getState().interaction;
      if (!interaction || interaction.type !== 'resize') return;

      // Resize all selected bins by same delta
      const newRects = new Map<BinId, Rect>();
      let allValid = true;
      let isSnapped = false;
      let invalidReason: ValidationReason | undefined;
      let blockingInfo: BlockingInfo | undefined;
      // kd: `binIds` also carries neighbors the solver is previewing; only bins
      // with a start rect are the ones the user is actually resizing.
      const primaryIds = [...interaction.startRects.keys()];
      const otherBinIds = new Set(primaryIds);
      const kdNeighborIds: BinId[] = [];
      kdSetBlockedMessage(undefined);

      const halfGridModeNow = useHalfGridModeStore.getState().halfGridMode;
      const minSizeNow = halfGridModeNow ? 0.5 : 1;

      for (const binId of primaryIds) {
        const bin = findBinById(layout, binId);
        const startRect = interaction.startRects.get(binId);
        if (!bin || !startRect) continue;

        const newRect = calculateResizeRect(
          startRect,
          interaction.handle,
          clamped,
          layout.drawer,
          minSizeNow
        );

        // kd: a single-bin resize goes through the layout solver (push / squeeze /
        // fixed, pins, minimum sizes, freed space). It answers null when the
        // editor's own placement rules reject its plan, and the code below takes over.
        const kdPlan =
          primaryIds.length === 1
            ? kdPlanResize({
                layout,
                layerId: activeLayerId,
                binId,
                requested: newRect,
                halfGrid: halfGridModeNow,
              })
            : null;
        if (kdPlan) {
          for (const [id, rect] of kdPlan.rects) newRects.set(id, rect);
          kdNeighborIds.push(...kdPlan.neighborIds);
          kdSetBlockedMessage(kdPlan.blockedMessage);
          if (kdPlan.blockedMessage !== undefined) isSnapped = true;
          continue;
        }

        const result = canPlaceBin(
          {
            ...newRect,
            height: bin.height,
            clearanceHeight: bin.clearanceHeight,
            linkedDesignId: bin.linkedDesignId,
          },
          activeLayerId,
          layout,
          binId,
          otherBinIds
        );

        if (!result.valid) {
          // Smart snap: find max valid size if Ctrl not held.
          // Each bin snaps independently — a uniform delta would over-constrain
          // groups where bins face different collision contexts.
          if (!ctrlKeyRef.current) {
            const snapResult = snapResizeRect(
              startRect,
              interaction.handle,
              newRect,
              bin.height,
              activeLayerId,
              layout,
              binId,
              otherBinIds,
              minSizeNow,
              layout.drawer,
              bin.clearanceHeight,
              bin.linkedDesignId
            );
            newRects.set(binId, snapResult.rect);
            if (snapResult.isSnapped) {
              isSnapped = true;
            }
          } else {
            newRects.set(binId, newRect);
            allValid = false;
            invalidReason = result.reason;
            blockingInfo = result.blockingInfo;
            break;
          }
        } else {
          newRects.set(binId, newRect);
        }
      }

      setInteraction({
        ...interaction,
        binIds: [...primaryIds, ...kdNeighborIds],
        currentRects: newRects,
        valid: allValid,
        isSnapped,
        invalidReason,
        blockingInfo,
      });
    },
    [layout, activeLayerId, setInteraction, ctrlKeyRef]
  );

  /**
   * Complete the resize interaction.
   * Commits bin dimension changes if there were any valid changes.
   */
  const handleUp = useCallback(() => {
    const interaction = useInteractionStore.getState().interaction;
    if (!interaction || interaction.type !== 'resize') return;

    // kd: say why the solver held the resize back (which bin, or which minimum).
    const kdBlocked = kdTakeBlockedMessage();
    if (kdBlocked !== undefined) addToast(kdBlocked, 'info');

    // Only commit if the resize was valid; show feedback when it isn't
    if (!interaction.valid) {
      if (interaction.invalidReason) {
        addToast(
          getPlacementErrorMessage(t, interaction.invalidReason, interaction.blockingInfo),
          'info'
        );
      }
      return;
    }

    let hasChanges = false;

    for (const binId of interaction.binIds) {
      const startRect = interaction.startRects.get(binId);
      const currentRect = interaction.currentRects.get(binId);
      if (!startRect || !currentRect) continue;

      if (
        startRect.x !== currentRect.x ||
        startRect.y !== currentRect.y ||
        startRect.width !== currentRect.width ||
        startRect.depth !== currentRect.depth
      ) {
        hasChanges = true;
        break;
      }
    }

    if (hasChanges) {
      const batchSize = interaction.binIds.length;

      // Find first bin with dimension changes for tracking (before execute)
      let firstResize: {
        old: { width: number; depth: number };
        new: { width: number; depth: number };
        height: number;
      } | null = null;

      for (const binId of interaction.binIds) {
        const bin = findBinById(layout, binId);
        const startRect = interaction.startRects.get(binId);
        const currentRect = interaction.currentRects.get(binId);
        if (!bin || !startRect || !currentRect) continue;

        if (startRect.width !== currentRect.width || startRect.depth !== currentRect.depth) {
          firstResize = {
            old: { width: startRect.width, depth: startRect.depth },
            new: { width: currentRect.width, depth: currentRect.depth },
            height: bin.height,
          };
          break;
        }
      }

      // kd: neighbors the solver moved are applied too, in an order where each
      // step is collision-free on its own (farthest pushed bin first).
      execute(() => {
        for (const { id, rect } of kdOrderedUpdates(
          layout,
          activeLayerId,
          interaction.currentRects
        )) {
          updateBin(id, rect);
        }
      });

      // Track once per batch operation (not per bin)
      if (firstResize) {
        mlTracking.trackResize(firstResize.old, firstResize.new, firstResize.height, batchSize);

        // Track quick corrections for each resized bin
        for (const binId of interaction.binIds) {
          const bin = findBinById(layout, binId);
          const startRect = interaction.startRects.get(binId);
          const currentRect = interaction.currentRects.get(binId);
          if (!bin || !startRect || !currentRect) continue;

          if (startRect.width !== currentRect.width || startRect.depth !== currentRect.depth) {
            mlTracking.trackQuickCorrect('resize', binId, bin, {
              width: currentRect.width,
              depth: currentRect.depth,
              height: bin.height,
            });
          }
        }
      }

      // Emit sync events for linked bins that changed dimensions.
      // Deduplicate by linkedDesignId — when multiple bins share the same
      // design, emit only one event (the first encountered) to avoid
      // concurrent IDB writes and duplicate cascade attempts.
      const emittedDesigns = new Set<string>();
      for (const binId of interaction.binIds) {
        const bin = findBinById(layout, binId);
        // kd: solver-resized neighbors have no start rect; their size before the
        // drop is still the bin's own.
        const startRect = interaction.startRects.get(binId) ?? bin;
        const currentRect = interaction.currentRects.get(binId);
        if (!bin?.linkedDesignId || !startRect || !currentRect) continue;
        if (emittedDesigns.has(bin.linkedDesignId)) continue;

        if (startRect.width !== currentRect.width || startRect.depth !== currentRect.depth) {
          emittedDesigns.add(bin.linkedDesignId);
          emitSyncEvent({
            type: 'bin-resized',
            binId,
            linkedDesignId: bin.linkedDesignId,
            newDimensions: {
              width: currentRect.width,
              depth: currentRect.depth,
              height: bin.height,
            },
          });
        }
      }
    }

    // Note: setInteraction(null) is called by the parent hook
  }, [layout, activeLayerId, execute, updateBin, t, addToast]);

  return { start, handleMove, handleUp };
}
