import assert from 'node:assert/strict';
import { normalizeSharedAuthorDraftForUse } from '../src/lib/image-studio/tasks';
import { readStudioRecentUse } from '../src/lib/image-studio/recent-use';
import { deriveModuleGallery, mergeModuleGalleryLastOpened } from '../src/app/image-studio/module-gallery-state';

// Shared template rules (2026-10-25): context is the author's; colleagues may change settings and swap style groups.
type Normalize = Parameters<typeof normalizeSharedAuthorDraftForUse>;
const shared = (mode: 'publisher' | 'live', ownerId = 'author') => ({ binding: { mode, ownerId },
  definition: { sourceOwnerId: 'author', context: 'secret context', fixedReferences: [], styleGroupIds: ['s1'], reproduction: null } }) as unknown as Normalize[1];
const actor = (id: string, role = 'user') => ({ id, role }) as unknown as Normalize[0];
const input = (draft: Record<string, unknown>) => ({ draft: { ...draft } }) as unknown as Normalize[2];

// Colleague (not author, not admin publisher): may swap style groups; the choice is kept for the task.
const swap = input({ styleGroupIds: ['mine-1'] });
normalizeSharedAuthorDraftForUse(actor('colleague'), shared('live'), swap);
assert.deepEqual((swap.draft as { styleGroupIds?: string[] }).styleGroupIds, ['mine-1']);
const removeAll = input({ styleGroupIds: [] });
normalizeSharedAuthorDraftForUse(actor('colleague'), shared('live'), removeAll);
assert.deepEqual((removeAll.draft as { styleGroupIds?: string[] }).styleGroupIds, []);
// Colleague can never send a context, fixed references or prompt groups.
assert.throws(() => normalizeSharedAuthorDraftForUse(actor('colleague'), shared('live'), input({ moduleContext: 'x' })), /历史定义/);
assert.throws(() => normalizeSharedAuthorDraftForUse(actor('colleague'), shared('live'), input({ styleGroupIds: ['a'], moduleContext: 'x' })), /历史定义/);
assert.throws(() => normalizeSharedAuthorDraftForUse(actor('colleague'), shared('live'), input({ fixedReferences: [] })), /历史定义/);
assert.throws(() => normalizeSharedAuthorDraftForUse(actor('colleague'), shared('live'), input({ skillIds: ['k'] })), /历史定义/);
// Author (publisher): unsaved style changes still must be saved first; matching ones are dropped as redundant.
assert.throws(() => normalizeSharedAuthorDraftForUse(actor('author'), shared('publisher'), input({ styleGroupIds: ['other'] })), /尚未保存/);
const same = input({ styleGroupIds: ['s1'] });
normalizeSharedAuthorDraftForUse(actor('author'), shared('publisher'), same);
assert.equal((same.draft as { styleGroupIds?: string[] }).styleGroupIds, undefined);

async function recentUse() {
  // 最近使用: own generations by template, newest first; unused templates keep directory order.
  const fake = { imageStudioTask: { groupBy: async ({ by }: { by: string[] }) => by[0] === 'module_id'
    ? [{ module_id: 'm1', _max: { created_at: new Date(1000) } }, { module_id: 'm2', _max: { created_at: new Date(3000) } }]
    : [{ source_preset_id: 'p1', _max: { created_at: new Date(2000) } }] } };
  const recent = await readStudioRecentUse('u', fake as never);
  assert.deepEqual(Object.keys(recent), ['module:m2', 'preset:p1', 'module:m1']);
  const catalog = ['module:a', 'module:m1', 'preset:p1', 'module:b', 'module:m2'].map(key => ({ id: key, key, name: key, groupName: 'g', mine: true, shared: false }));
  const merged = mergeModuleGalleryLastOpened({ 'module:a': 1500 }, recent, Date.now());
  assert.deepEqual(deriveModuleGallery(catalog, { sort: 'recent', lastOpened: merged }).filteredEntries.map(entry => entry.key),
    ['module:m2', 'preset:p1', 'module:a', 'module:m1', 'module:b']);
  console.log('image studio shared consumer smoke: ok');
}
recentUse().catch(error => { console.error(error); process.exit(1); });
