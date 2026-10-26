import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual independent protocol with isolated transaction delegates.
// Real shared-source authorization remains covered by the author/cover gate, not these stubs.
const root = realpathSync(process.cwd()), checks: string[] = [];
const source = 'src/lib/content-reactions/independent.ts';
let allowed = true, enabled = true, bound = false, writes = 0;
const rows = new Map<string, any>(), events = new Map<string, any>();
const actor = { id: 'owner-a', status: 'active', account_type: 'internal' };
const db: any = {
  imageStudioPreset: { findUnique: async ({ where }: any) => ({ id: where.id, owner_id: actor.id, is_shared: allowed }) },
  imageStudioModule: { findFirst: async ({ where }: any) => where.owner_id === actor.id ? { id: where.id, owner_id: actor.id, source_preset_id: null } : null },
  contentReaction: {
    findUnique: async ({ where }: any) => rows.get(`${where.user_id_content_key.user_id}/${where.user_id_content_key.content_key}`) || null,
    count: async ({ where }: any) => Array.from(rows.values()).filter(row => row.content_key === where.content_key && row.liked).length,
    create: async ({ data }: any) => { writes++; const row = { id: `row-${rows.size}`, liked: false, favorited: false, liked_at: null, favorited_at: null, version: 1, ...data }; rows.set(`${data.user_id}/${data.content_key}`, row); return row; },
    updateMany: async ({ where, data }: any) => { const row = Array.from(rows.values()).find(row => row.id === where.id && row.version === where.version); if (!row) return { count: 0 }; writes++; Object.assign(row, data, { version: row.version + 1 }); return { count: 1 }; },
  },
  contentReactionEvent: {
    findUnique: async ({ where }: any) => events.get(`${where.user_id_request_id.user_id}/${where.user_id_request_id.request_id}`) || null,
    create: async ({ data }: any) => { const key = `${data.user_id}/${data.request_id}`; assert(!events.has(key)); writes++; events.set(key, data); return data; },
  },
};
db.$transaction = async (run: any) => {
  const beforeRows = structuredClone(rows), beforeEvents = structuredClone(events), beforeWrites = writes;
  try { return await run(db); } catch (error) { rows.clear(); events.clear(); for (const [key, row] of Array.from(beforeRows)) rows.set(key, row); for (const [key, event] of Array.from(beforeEvents)) events.set(key, event); writes = beforeWrites; throw error; }
};
class Rejection extends Error { constructor(message: string, public status = 400) { super(message); } }
const api: any = {};
const fixtureRequire = (name: string) => {
  if (name === 'server-only') return {};
  if (name === 'node:crypto') return { createHash };
  if (name === '@/lib/prisma') return { prisma: db };
  if (name === './content') return { ReactionError: Rejection };
  if (name === './key') return { tryContentKeyParts: (key: unknown) => typeof key === 'string' && /^(image_template|image_module):[a-z0-9-]+$/.test(key)
    ? { key, type: key.split(':')[0], id: key.split(':')[1] } : null };
  if (name === '@/lib/image-studio/shared-contract') return { StudioSharingError: Rejection,
    assertStudioActor: async (id: string) => { if (!enabled || id !== actor.id) throw new Rejection('actor unavailable', 403); return actor; },
    sharedStudioAvailability: async () => allowed, studioSharedBinding: async () => bound ? { presetId: 'source-a' } : null };
  if (name === '@/lib/image-studio/workspace-deletion') return { readStudioWorkspaceDeletion: async () => null };
  throw new Error(`Unapproved cover-pool engineering import: ${name}`);
};
vm.runInNewContext(ts.transpileModule(readFileSync(path.join(root, source), 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText, { exports: api, require: fixtureRequire, Date, Map, Set, Promise }, { filename: source });

async function main() {
  const key = 'image_template:source-a';
  const operation = (requestId: string, changes: object = {}) => ({ protocol: 2, viewerId: actor.id, key, requestId, action: 'like', active: true, expectedVersion: 0, ...changes });
  const favoriteAt = new Date(1000);
  rows.set(`${actor.id}/${key}`, { id: 'history', content_key: key, user_id: actor.id, liked: false, favorited: true, favorited_at: favoriteAt, liked_at: null, version: 4 });
  let result = await api.setIndependentReaction(actor, operation('like-request', { expectedVersion: 4 }));
  assert.equal(result.state.liked, true); assert.equal(result.state.favorited, true);
  assert.equal(rows.get(`${actor.id}/${key}`).favorited_at, favoriteAt);
  checks.push('actual_v2_like_preserves_favorite_and_its_original_timestamp');
  const likedAt = rows.get(`${actor.id}/${key}`).liked_at;
  result = await api.setIndependentReaction(actor, operation('favorite-request', { action: 'favorite', active: false, expectedVersion: 5 }));
  assert.equal(result.state.liked, true); assert.equal(result.state.favorited, false);
  assert.equal(rows.get(`${actor.id}/${key}`).liked_at, likedAt); assert.equal(result.state.likeCount, 1);
  checks.push('actual_v2_favorite_preserves_like_timestamp_and_public_count');
  const beforeReplay = writes;
  await api.setIndependentReaction(actor, operation('like-request', { expectedVersion: 4 }));
  assert.equal(writes, beforeReplay);
  assert.equal((await api.readIndependentReaction(actor, { key, requestId: 'like-request' })).status, 'committed');
  assert.equal((await api.readIndependentReaction(actor, { key, requestId: 'missing-request' })).status, 'unknown');
  checks.push('same_original_event_replays_without_write_and_absent_receipt_stays_unknown');
  await assert.rejects(api.setIndependentReaction(actor, operation('like-request', { expectedVersion: 4, active: false })), { status: 409 });
  events.set(`${actor.id}/legacy-request`, { content_key: key, fingerprint: 'legacy-hash' });
  await assert.rejects(api.readIndependentReaction(actor, { key, requestId: 'legacy-request' }), { status: 409 });
  await assert.rejects(api.setIndependentReaction(actor, operation('legacy-request', { expectedVersion: 6 })), { status: 409 });
  await assert.rejects(api.setIndependentReaction(actor, operation('stale-request', { expectedVersion: 0 })), { status: 409 });
  assert.equal(writes, beforeReplay);
  checks.push('protocol_namespace_original_content_and_cas_conflicts_never_write_or_replay');
  allowed = false;
  await assert.rejects(api.setIndependentReaction(actor, operation('revoked-request', { expectedVersion: 6 })), { status: 404 });
  result = await api.setIndependentReaction(actor, operation('remove-own-mark', { active: false, expectedVersion: 6 }));
  assert.equal(result.state.available, false); assert.equal(result.state.likeCount, null); assert.equal(result.state.liked, false);
  enabled = false;
  await assert.rejects(api.setIndependentReaction(actor, operation('disabled-request', { expectedVersion: 7 })), { status: 403 });
  enabled = true; allowed = true; bound = true;
  await assert.rejects(api.setIndependentReaction(actor, operation('wrong-key-request', { key: 'image_module:module-a' })), { status: 404 });
  await assert.rejects(api.setIndependentReaction(actor, operation('wrong-actor-request', { viewerId: 'owner-b' })), { status: 409 });
  checks.push('fresh_transaction_actor_source_revocation_and_bound_module_key_guards');
  const studioFile = 'src/app/image-studio/studio.tsx';
  const studioAst = ts.createSourceFile(studioFile, readFileSync(path.join(root, studioFile), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let projection: ts.Expression | undefined;
  const findProjection = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(studioAst) === 'naturalNavigation'
      && node.initializer && ts.isCallExpression(node.initializer)) projection = node.initializer.arguments[0];
    ts.forEachChild(node, findProjection);
  };
  findProjection(studioAst); assert(projection, 'actual sidebar projection must exist');
  const directory = [
    { id: 'local-a', name: 'same name', sourcePresetId: null, sourcePresetShared: false },
    { id: 'shared:source-a', presetId: 'source-a', sourcePresetId: 'source-a', sourcePresetShared: true, name: 'same name' },
    { id: 'legacy-copy', sourcePresetId: 'source-a', sourcePresetShared: true, name: 'same name' },
    { id: 'bound-b', presetId: 'source-b', sourcePresetId: 'source-b', sourcePresetShared: true, name: 'bound source' },
    { id: 'history-a', sourcePresetId: 'withdrawn', sourcePresetShared: null, name: 'remembered history' },
    { id: 'default-owner-a', sourcePresetId: null, sourcePresetShared: false, name: 'virtual default' },
  ];
  const modules = [{ id: 'local-a', name: 'stale loaded name' }, { id: 'not-authorized', name: 'must not return' },
    { id: 'history-a', name: 'old source', sharedLive: { available: false, intent: { presetId: 'withdrawn' } },
      fixedCover: { available: true, thumbnailUrl: 'old-cover', imageUrl: 'old-original' } }];
  const beforeNavigation = JSON.stringify([directory, modules]), projected: any = {};
  vm.runInNewContext(ts.transpileModule(`exports.project = ${projection.getText(studioAst)};`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, { exports: projected, directory, modules, userId: actor.id, Map, Array,
    navigationMemory: { get: (value: any) => ({ name: value.name, groupName: 'history' }) } });
  const navigation = projected.project();
  assert.equal(navigation.length, directory.length);
  assert.deepEqual(Array.from(navigation, (item: any) => item.id).sort(), directory.map(item => item.id).sort());
  assert.equal(navigation.find((item: any) => item.id === 'local-a').name, 'same name');
  assert.equal(navigation.find((item: any) => item.id === 'history-a').fixedCover.imageUrl, null);
  assert.equal(navigation.find((item: any) => item.id === 'history-a').fixedCover.available, false);
  assert.equal(JSON.stringify([directory, modules]), beforeNavigation);
  checks.push('actual_sidebar_projection_keeps_authorized_sources_copies_history_virtuals_without_heavy_catalog_or_writes');
  const files = ['scripts/cover-pool-engineering.ts', source, 'src/lib/image-studio/gallery.ts', 'src/lib/image-studio/gallery-context.ts',
    'src/lib/image-studio/gallery-types.ts', 'src/lib/image-studio/shared-contract.ts', 'src/app/api/content-reactions/independent/route.ts',
    'src/app/api/image-studio/gallery/query/route.ts', 'src/components/content-reactions/GalleryReactionButtons.tsx',
    'src/app/image-studio/module-gallery-state.ts', 'src/app/image-studio/useModuleGalleryState.ts', 'src/app/image-studio/useGalleryCatalog.ts', studioFile];
  const receipt = { schema: 'cover-pool-engineering.v1', completed: true, synthetic: true, candidateRoot: root,
    runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID, applicationDatabaseOpened: false, productionWrites: 0, forbiddenCalls: 0, paidRequests: 0, browserRuns: 0,
    checks, sourceSha256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')])) };
  writeFileSync(process.argv[2], JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`Cover pool engineering receipt: ${process.argv[2]}`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
