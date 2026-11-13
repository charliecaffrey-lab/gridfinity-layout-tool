/* eslint-disable i18next/no-literal-string -- Kitchen Drawers fork: English only, kept out of the upstream locale files so merges stay clean. */
import { batch } from '@/core/cqrs';
import {
  useHalfGridModeStore,
  useLayoutStore,
  useSelectionStore,
  useToastStore,
} from '@/core/store';
import { Button, SegmentedControl, Stepper } from '@/design-system';
import { PanelSection } from '@/shared/components/PanelSection';
import { useMutations } from '@/shared/contexts/MutationsContext';
import { kdPlanFill } from './editor';
import { useKdSolverSettings } from './settings';
import type { FreedMode, ResizeMode } from './solver';

const MODE_HELP: Record<ResizeMode, string> = {
  push: 'Neighbors slide over when a bin grows, if there is room.',
  squeeze: 'Neighbors shrink to make room, never below their minimum.',
  fixed: 'A growing bin stops at the first neighbor.',
};

const FREED_HELP: Record<FreedMode, string> = {
  leaveGap: 'Space a bin gives up stays empty.',
  absorb: 'Space a bin gives up goes to the neighbor on that side.',
};

/** Sidebar controls for how neighbors react to an edit, plus "Fill empty space". */
export function KdSolverPanel() {
  const { mode, freed, fillMaxW, fillMaxD, update } = useKdSolverSettings();
  const mutations = useMutations();

  const fill = (): void => {
    const layout = useLayoutStore.getState().layout;
    const { activeLayerId, activeCategoryId } = useSelectionStore.getState();
    const layer = layout.layers.find((l) => l.id === activeLayerId);
    if (!layer) return;
    const rects = kdPlanFill(layout, activeLayerId, useHalfGridModeStore.getState().halfGridMode);
    batch(() => {
      for (const rect of rects) {
        mutations.addBin({
          ...rect,
          layerId: activeLayerId,
          height: layer.height,
          category: activeCategoryId,
          label: '',
          notes: '',
        });
      }
    });
    useToastStore.getState().addToast({
      message:
        rects.length === 0
          ? 'There is no empty space to fill on this layer.'
          : `Added ${rects.length} ${rects.length === 1 ? 'bin' : 'bins'} (largest ${fillMaxW}×${fillMaxD}).`,
      type: rects.length === 0 ? 'info' : 'success',
    });
  };

  return (
    <PanelSection className="space-y-3 text-xs text-content-secondary">
      <div className="text-sm font-medium text-content">Neighbors</div>

      <div className="space-y-1">
        <div>When a bin grows</div>
        <SegmentedControl<ResizeMode>
          aria-label="When a bin grows"
          size="sm"
          value={mode}
          onChange={(value) => update({ mode: value })}
          options={[
            { value: 'push', label: 'Push' },
            { value: 'squeeze', label: 'Squeeze' },
            { value: 'fixed', label: 'Fixed' },
          ]}
        />
        <div data-testid="kd-mode-help">{MODE_HELP[mode]}</div>
      </div>

      <div className="space-y-1">
        <div>Freed space</div>
        <SegmentedControl<FreedMode>
          aria-label="Freed space"
          size="sm"
          value={freed}
          onChange={(value) => update({ freed: value })}
          options={[
            { value: 'leaveGap', label: 'Leave gap' },
            { value: 'absorb', label: 'Absorb' },
          ]}
        />
        <div>{FREED_HELP[freed]}</div>
      </div>

      <div className="space-y-1">
        <div>Fill empty space: largest bin (grid units)</div>
        <div className="grid grid-cols-2 gap-2">
          <Stepper
            aria-label="Largest fill bin width"
            size="sm"
            fullWidth
            value={fillMaxW}
            min={1}
            max={50}
            onChange={(value) => update({ fillMaxW: value })}
            onStep={(delta) => update({ fillMaxW: Math.min(50, Math.max(1, fillMaxW + delta)) })}
          />
          <Stepper
            aria-label="Largest fill bin depth"
            size="sm"
            fullWidth
            value={fillMaxD}
            min={1}
            max={50}
            onChange={(value) => update({ fillMaxD: value })}
            onStep={(delta) => update({ fillMaxD: Math.min(50, Math.max(1, fillMaxD + delta)) })}
          />
        </div>
        <Button variant="secondary" size="sm" fullWidth onClick={fill}>
          Fill empty space
        </Button>
      </div>
    </PanelSection>
  );
}
