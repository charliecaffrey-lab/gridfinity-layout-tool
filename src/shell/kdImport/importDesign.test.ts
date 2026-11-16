import { describe, expect, it } from 'vitest';
import { isOk } from '@/core/result';
import { listDesigns } from '@/features/bin-designer/storage/DesignerStorage';
import { defaultsForNewDesign } from '@/features/bin-designer/store/helpers';
import { exportDesignJSON } from '@/features/bin-designer/utils/designJson';
import { kdImportDesign } from './importDesign';

const message = (json: string) => ({ type: 'kd:import-design' as const, requestId: 'r1', json });

describe('kdImportDesign', () => {
  it('saves a design file into the library under its own name', async () => {
    const json = exportDesignJSON('Spice jar holder', defaultsForNewDesign());
    const result = await kdImportDesign(message(json));
    expect(result).toMatchObject({ ok: true, name: 'Spice jar holder' });
    const designs = await listDesigns();
    expect(isOk(designs) && designs.value.some((d) => d.id === result.designId)).toBe(true);
  });

  it('explains a file that is not a bin design', async () => {
    const notJson = await kdImportDesign(message('{oops'));
    expect(notJson.ok).toBe(false);
    expect(notJson.reason).toBeTruthy();
    const layout = await kdImportDesign(message(JSON.stringify({ bins: [], drawer: {} })));
    expect(layout.ok).toBe(false);
  });
});
