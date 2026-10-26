import assert from 'node:assert/strict';
import { studioResultOrigin, studioResultOriginAsset } from '../src/lib/image-studio/result-origin';

// No provider, HTTP, production database or image encoding: frozen task rows only.
async function main() {
  const frozen = (ids: string[]) => ({ snapshot_json: JSON.stringify({
    referencePolicy: { primaryIds: ids }, primaryReferenceImages: ids.map(id => ({ id, referenceRole: 'primary' })),
  }), reference_ids: JSON.stringify(ids) });
  const tasks: Record<string, { snapshot_json: string; reference_ids: string }> = {
    result1: frozen(['source1']), multiple: frozen(['source1', 'source2']), textonly: frozen([]),
    legacy: { snapshot_json: JSON.stringify({ primaryReferenceImages: [{ id: 'source1' }] }), reference_ids: '["source1"]' },
    wrongrole: { snapshot_json: JSON.stringify({ referencePolicy: { primaryIds: ['source1'] },
      primaryReferenceImages: [{ id: 'source1', referenceRole: 'auxiliary' }] }), reference_ids: '["source1"]' },
    mismatch: { ...frozen(['source1']), reference_ids: '["other"]' },
  };
  const fake = { imageStudioTask: { findFirst: async ({ where }: { where: { owner_id: string; asset_id: string; deleted_at: unknown } }) => {
    assert.equal(where.deleted_at, null, 'deleted task inputs remain protected');
    return where.owner_id === 'me' ? tasks[where.asset_id] || null : null;
  } } };
  assert.equal(await studioResultOriginAsset('me', 'result1', fake as never), 'source1');
  assert.deepEqual(await studioResultOrigin('me', 'multiple', fake as never), { state: 'multiple' });
  assert.equal(await studioResultOriginAsset('me', 'multiple', fake as never), null, 'never guess the first of several inputs');
  assert.deepEqual(await studioResultOrigin('me', 'textonly', fake as never), { state: 'none' });
  for (const id of ['legacy', 'wrongrole', 'mismatch']) {
    assert.deepEqual(await studioResultOrigin('me', id, fake as never), { state: 'unknown' });
  }
  assert.equal(await studioResultOriginAsset('other', 'result1', fake as never), null, 'only own tasks');
  assert.equal(await studioResultOriginAsset('me', '../x', fake as never), null, 'bad id');
  console.log('cover origin smoke: ok');
}
main().catch(error => { console.error(error); process.exit(1); });
