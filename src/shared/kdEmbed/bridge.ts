/**
 * Kitchen Drawers embed bridge. When the editor is opened in a frame with
 * `?kd=1&kdParent=<origin>`, the parent page hands it one drawer's layout and
 * asks for it back on save. The parent's database is the source of truth; this
 * browser's own library is only a working copy, one entry per drawer.
 */
import { createLayoutWithSettings } from '@/core/constants';
import { useHistoryStore } from '@/core/cqrs/undo/historyStore';
import { isErr, isOk } from '@/core/result';
import {
  createLayoutEntry,
  exportLayoutJSONWithDesigns,
  restoreEmbeddedDesigns,
  switchActiveLayout,
} from '@/core/storage';
import {
  queueLibraryWrite,
  saveOpenLayout,
  useLayoutStore,
  useLibraryStore,
  useSelectionStore,
  useSettingsStore,
} from '@/core/store';
import type { Layout, LayoutId } from '@/core/types';
import { layoutId as toLayoutId } from '@/core/types';
import { buildDrawerLinkLayout } from '@/shared/utils/drawerLink';
import { validateImport } from '@/shared/utils/validationImport';
import { isKdParentMessage } from './protocol';
import type {
  KdAddFittedBinMessage,
  KdApplyBinsMessage,
  KdEditorMessage,
  KdExportPrintSetMessage,
  KdLoadMessage,
} from './protocol';

export interface KdApplyBinsResult {
  ok: boolean;
  added?: { index: number; binId: string }[];
  failed?: string[];
  reason?: string;
}

export interface KdFittedBinResult {
  ok: boolean;
  binId?: string;
  units?: { w: number; d: number; h: number };
  placed?: 'grid' | 'stash';
  notes?: string[];
  reason?: string;
}

export interface KdPrintSetResult {
  ok: boolean;
  linkedBins: number;
  reason?: string;
}

/** Work the bridge cannot do itself because it needs feature code; the app shell supplies it. */
export interface KdBridgeHandlers {
  exportPrintSet?: (message: KdExportPrintSetMessage) => Promise<KdPrintSetResult>;
  addFittedBin?: (message: KdAddFittedBinMessage) => Promise<KdFittedBinResult>;
  applyBins?: (message: KdApplyBinsMessage) => KdApplyBinsResult;
}

const MAP_KEY = 'kd-drawer-layouts-v1';

function readMap(): Record<string, string | undefined> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage.getItem(MAP_KEY) ?? '{}');
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, string | undefined>)
      : {};
  } catch {
    return {};
  }
}

function rememberLayout(drawerId: string, id: string): void {
  try {
    globalThis.localStorage.setItem(MAP_KEY, JSON.stringify({ ...readMap(), [drawerId]: id }));
  } catch {
    // Without storage every visit simply makes a fresh working copy.
  }
}

/** Parse a saved layout without regenerating ids, so bin ids stay stable across saves. */
export async function kdLayoutFromMessage(message: KdLoadMessage): Promise<Layout | string> {
  if (message.layoutJson !== null) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message.layoutJson) as Record<string, unknown>;
    } catch {
      return 'The saved layout is not valid JSON.';
    }
    delete parsed._meta;
    const validation = validateImport(parsed);
    if (!validation.valid) return validation.errors.join('; ');
    const restored = await restoreEmbeddedDesigns(message.layoutJson, validation.layout);
    return { ...restored.layout, name: message.name };
  }
  const base = createLayoutWithSettings(useSettingsStore.getState().settings);
  const built = buildDrawerLinkLayout(
    base,
    {
      widthMm: message.interiorMm.w,
      depthMm: message.interiorMm.d,
      heightMm: message.interiorMm.h,
      name: message.name,
    },
    message.name
  );
  if (isErr(built)) return 'That drawer is too small or too large for a Gridfinity grid.';
  // A drawer's baseplate is usually printed in several pieces. Give a new drawer
  // interlocking puzzle tabs so the pieces hold together; it can be changed on
  // the Baseplate tab.
  const baseplate = built.value.baseplateParams;
  return baseplate
    ? {
        ...built.value,
        baseplateParams: { ...baseplate, connectorNubs: true, connectorStyle: 'puzzle' },
      }
    : built.value;
}

function activate(layout: Layout, id: LayoutId): void {
  useLayoutStore.getState().importLayout(layout, id, 'init');
  const selection = useSelectionStore.getState();
  selection.clearSelection();
  if (layout.layers[0]) selection.setActiveLayer(layout.layers[0].id);
  if (layout.categories[0]) selection.setActiveCategory(layout.categories[0].id);
  useHistoryStore.getState().clear();
}

/** Open the layout as this drawer's working copy, reusing the copy from an earlier visit. */
async function openWorkingCopy(drawerId: string, layout: Layout): Promise<boolean> {
  // Flush the outgoing layout first: activation would cancel an autosave still in its debounce.
  if (isErr(await saveOpenLayout())) return false;

  const known = readMap()[drawerId];
  const library = useLibraryStore.getState().library;
  if (known !== undefined && library.entries.some((entry) => entry.id === known)) {
    if (library.activeLayoutId !== known) {
      const switched = await queueLibraryWrite(async (latest) => {
        const result = await switchActiveLayout(
          latest.activeLayoutId,
          useLayoutStore.getState().layout,
          known,
          latest
        );
        if (isOk(result)) useLibraryStore.getState().setLibrary(result.value.library);
        return result;
      });
      if (isErr(switched)) return false;
    }
    activate(layout, toLayoutId(known));
    return isOk(await saveOpenLayout());
  }

  const created = await queueLibraryWrite(async (latest) => {
    const result = await createLayoutEntry(layout, latest, {
      name: layout.name,
      author: latest.settings.authorName,
      activate: true,
    });
    if (isOk(result)) {
      useLibraryStore.getState().setLibrary(result.value.library);
      activate(result.value.layout, toLayoutId(result.value.layoutId));
    }
    return result;
  });
  if (isErr(created)) return false;
  rememberLayout(drawerId, created.value.layoutId);
  return true;
}

/**
 * Start listening. Returns a function that stops the bridge.
 * `parentOrigin` comes from the URL; messages from anywhere else are ignored.
 */
export function startKdEmbedBridge(
  parentOrigin: string,
  parent: Window,
  handlers: KdBridgeHandlers = {}
): () => void {
  let drawerId: string | null = null;
  let loading = false;
  // A freshly loaded layout is tidied by the editor itself (linked designs
  // re-sync their bins). Those are not the person's edits, so nothing counts as
  // a change until they have clicked or typed in the editor.
  let userActed = false;
  const markActed = (): void => {
    userActed = true;
  };
  let changeTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (message: KdEditorMessage): void => parent.postMessage(message, parentOrigin);

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== parentOrigin || event.source !== parent) return;
    const message: unknown = event.data;
    if (!isKdParentMessage(message)) return;

    if (message.type === 'kd:load') {
      loading = true;
      userActed = false;
      void (async () => {
        const layout = await kdLayoutFromMessage(message);
        if (typeof layout === 'string') {
          send({ type: 'kd:load-failed', drawerId: message.drawerId, reason: layout });
        } else if (await openWorkingCopy(message.drawerId, layout)) {
          drawerId = message.drawerId;
          send({ type: 'kd:loaded', drawerId: message.drawerId });
        } else {
          send({
            type: 'kd:load-failed',
            drawerId: message.drawerId,
            reason: 'The editor could not store a working copy in this browser.',
          });
        }
      })().finally(() => {
        loading = false;
      });
      return;
    }

    if (message.type === 'kd:apply-bins') {
      const { requestId } = message;
      if (drawerId === null || !handlers.applyBins) {
        send({
          type: 'kd:bins-applied',
          requestId,
          ok: false,
          reason:
            drawerId === null
              ? 'No drawer is loaded yet.'
              : 'This editor build cannot apply plans.',
        });
        return;
      }
      userActed = true;
      let result: KdApplyBinsResult;
      try {
        result = handlers.applyBins(message);
      } catch {
        result = { ok: false, reason: 'Applying the plan stopped with an error.' };
      }
      send({ type: 'kd:bins-applied', requestId, ...result });
      return;
    }

    if (message.type === 'kd:add-fitted-bin') {
      const { requestId } = message;
      const refuse = (reason: string): void =>
        send({ type: 'kd:fitted-bin-done', requestId, ok: false, reason });
      if (drawerId === null) refuse('No drawer is loaded yet.');
      else if (!handlers.addFittedBin) refuse('This editor build cannot make fitted bins.');
      else {
        // A new bin is a change worth saving even if the person never clicked in the editor.
        userActed = true;
        void handlers
          .addFittedBin(message)
          .catch(() => ({ ok: false, reason: 'Making the fitted bin stopped with an error.' }))
          .then((result) => send({ type: 'kd:fitted-bin-done', requestId, ...result }));
      }
      return;
    }

    if (message.type === 'kd:export-print-set') {
      const { requestId } = message;
      const refuse = (reason: string): void =>
        send({ type: 'kd:print-set-done', requestId, ok: false, linkedBins: 0, reason });
      let uploadOrigin: string | null;
      try {
        uploadOrigin = new URL(message.uploadUrl).origin;
      } catch {
        uploadOrigin = null;
      }
      if (drawerId === null) refuse('No drawer is loaded yet.');
      else if (uploadOrigin !== parentOrigin) refuse('The upload address is not the kitchen app.');
      else if (!handlers.exportPrintSet) refuse('This editor build cannot export print sets.');
      else {
        // The export links plain bins to designs, which is a change worth saving.
        userActed = true;
        void handlers
          .exportPrintSet(message)
          .catch(() => ({ ok: false, linkedBins: 0, reason: 'The export stopped with an error.' }))
          .then((result) => send({ type: 'kd:print-set-done', requestId, ...result }));
      }
      return;
    }

    const { requestId } = message;
    const current = drawerId;
    if (current === null) {
      send({ type: 'kd:layout-failed', requestId, reason: 'No drawer is loaded yet.' });
      return;
    }
    void exportLayoutJSONWithDesigns(useLayoutStore.getState().layout).then((exported) => {
      if (isOk(exported)) {
        send({ type: 'kd:layout', requestId, drawerId: current, layoutJson: exported.value });
      } else {
        send({
          type: 'kd:layout-failed',
          requestId,
          reason: 'A bin design in this layout is missing one of its imported 3D files.',
        });
      }
    });
  };

  const unsubscribe = useLayoutStore.subscribe((state, previous) => {
    if (drawerId === null || loading || !userActed || state.layout === previous.layout) return;
    if (state.lastEditSource === 'init') return;
    const current = drawerId;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => send({ type: 'kd:changed', drawerId: current }), 250);
  });

  globalThis.addEventListener('message', onMessage);
  globalThis.addEventListener('pointerdown', markActed, true);
  globalThis.addEventListener('keydown', markActed, true);
  send({ type: 'kd:ready' });

  return () => {
    globalThis.removeEventListener('message', onMessage);
    globalThis.removeEventListener('pointerdown', markActed, true);
    globalThis.removeEventListener('keydown', markActed, true);
    unsubscribe();
    clearTimeout(changeTimer);
  };
}
