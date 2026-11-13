import { create } from 'zustand';
import type { FreedMode, ResizeMode } from './solver';

const STORAGE_KEY = 'kd-solver-settings-v1';

export interface KdSolverSettings {
  mode: ResizeMode;
  freed: FreedMode;
  /** Largest bin "Fill empty space" may create, in grid units. */
  fillMaxW: number;
  fillMaxD: number;
}

export const KD_DEFAULT_SETTINGS: KdSolverSettings = {
  mode: 'push',
  freed: 'leaveGap',
  fillMaxW: 4,
  fillMaxD: 4,
};

function clampSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(50, Math.max(1, Math.round(value)))
    : KD_DEFAULT_SETTINGS.fillMaxW;
}

function load(): KdSolverSettings {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return KD_DEFAULT_SETTINGS;
    const saved = JSON.parse(raw) as Partial<KdSolverSettings>;
    return {
      mode: saved.mode === 'squeeze' || saved.mode === 'fixed' ? saved.mode : 'push',
      freed: saved.freed === 'absorb' ? 'absorb' : 'leaveGap',
      fillMaxW: clampSize(saved.fillMaxW),
      fillMaxD: clampSize(saved.fillMaxD),
    };
  } catch {
    return KD_DEFAULT_SETTINGS;
  }
}

interface KdSolverStore extends KdSolverSettings {
  update: (changes: Partial<KdSolverSettings>) => void;
}

export const useKdSolverSettings = create<KdSolverStore>((set, get) => ({
  ...load(),
  update: (changes) => {
    set(changes);
    const { mode, freed, fillMaxW, fillMaxD } = get();
    try {
      globalThis.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ mode, freed, fillMaxW, fillMaxD })
      );
    } catch {
      // Private windows can refuse storage; the setting still holds for this visit.
    }
  },
}));
