import assert from 'node:assert/strict';
import { studioResultOriginAsset } from '../src/lib/image-studio/result-origin';

// 左右/上下 covers: the source image of a result is the first primary input of the owner's own task.
async function main() {
  const tasks: Record<string, string | null> = {
    r1: JSON.stringify({ primaryReferenceImages: [{ id: 'src1' }, { id: 'src2' }] }), r2: JSON.stringify({ primaryReferenceImages: [] }), r3: 'not json',
  };
  const fake = { imageStudioTask: { findFirst: async ({ where }: { where: { owner_id: string; asset_id: string } }) =>
    where.owner_id === 'me' && where.asset_id in tasks ? { snapshot_json: tasks[where.asset_id] } : null } };
  assert.equal(await studioResultOriginAsset('me', 'r1', fake as never), 'src1');
  assert.equal(await studioResultOriginAsset('me', 'r2', fake as never), null, 'no input image');
  assert.equal(await studioResultOriginAsset('me', 'r3', fake as never), null, 'broken snapshot');
  assert.equal(await studioResultOriginAsset('other', 'r1', fake as never), null, 'only own tasks');
  assert.equal(await studioResultOriginAsset('me', '../x', fake as never), null, 'bad id');
  console.log('cover origin smoke: ok');
}
main().catch(error => { console.error(error); process.exit(1); });
