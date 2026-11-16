/**
 * Kitchen Drawers fork: save a bin design file (the designer's own JSON export,
 * for example one remixed from the community showcase on the public site) into
 * this browser's design library, without opening the designer.
 */
import { isOk } from '@/core/result';
import { saveDesign } from '@/features/bin-designer/storage/DesignerStorage';
import {
  registryParamsEntry,
  upsertRegistryEntry,
} from '@/features/bin-designer/store/customBinRegistry';
import { parseDesignJSON } from '@/features/bin-designer/utils/designJson';
import { getStaticTranslation } from '@/i18n';
import type { KdImportDesignResult } from '@/shared/kdEmbed/bridge';
import type { KdImportDesignMessage } from '@/shared/kdEmbed/protocol';

export async function kdImportDesign(
  message: KdImportDesignMessage
): Promise<KdImportDesignResult> {
  const parsed = parseDesignJSON(message.json, getStaticTranslation);
  if (!parsed.design) {
    return {
      ok: false,
      reason: parsed.errors.join('; ') || 'That is not a bin design file.',
    };
  }
  const saved = await saveDesign({
    name: parsed.design.name,
    params: parsed.design.params,
    thumbnail: null,
    exportFileNameConfig: null,
  });
  if (!isOk(saved)) {
    return { ok: false, reason: 'The bin design could not be saved in this browser.' };
  }
  // The layout editor offers a design for linking only once it is in the registry.
  const entry = registryParamsEntry(saved.value);
  if (entry) upsertRegistryEntry(entry);
  return { ok: true, name: saved.value.name, designId: saved.value.id };
}
