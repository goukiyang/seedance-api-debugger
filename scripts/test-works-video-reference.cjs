// Offline engineering checks; no live database, network, browser or generation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const storage = new Map();
const globals = { URL, URLSearchParams, crypto: webcrypto, window: { location: { origin: 'https://fixture.invalid' } },
  sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
function load(file, dependencies = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, reportDiagnostics: true,
  });
  assert.equal(code.diagnostics.length, 0);
  vm.runInNewContext(code.outputText, { exports, ...globals, require(id) {
    assert(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
    return dependencies[id];
  } }, { filename: file });
  return exports;
}
const returns = load('src/lib/navigation/return-to.ts');
const intents = load('src/lib/navigation/task-reuse-intent.ts');
const navigation = load('src/lib/navigation/task-reuse.ts', { './return-to': returns, './task-reuse-intent': intents });
const privacy = load('src/lib/video/multiview-task-privacy.ts', Object.fromEntries([
  '@/lib/character-assets/privacy', './task-thumbnail-projection', './multiview-action-contract', './prompt-groups',
].map(id => [id, {}])));
const { projectWorkProvenance } = load('src/lib/works/provenance.ts', {
  'server-only': {}, '@/lib/image-studio/access': {}, '@/lib/image-studio/preset-lifecycle': {}, '@/lib/template-studio/templates': {},
  '@/lib/video/multiview-task-privacy': privacy, './context-index': { worksContextSchemaReady: async () => false },
  '@/lib/navigation/task-reuse': navigation,
});
const operations = load('src/lib/navigation/task-reuse-operation.server.ts', {
  ...Object.fromEntries(['server-only', '@/lib/character-assets/video-reference.server', '@/lib/prisma', '@/lib/auth/session',
    '@/lib/projects/permissions', '@/lib/tasks/retention', '@/lib/reference-albums/permissions', '@/lib/assets/workspace',
    '@/lib/image-studio/read-snapshot', '@/lib/video/prompt-groups-build-mode'].map(id => [id, {}])),
  'node:crypto': require('node:crypto'), './task-reuse-intent': intents,
});
async function main() {
  assert.notEqual(operations.taskReuseSourceStamp({ id: 'draft', is_draft: true }),
    operations.taskReuseSourceStamp({ id: 'draft', is_draft: false }), 'The restored draft switch participates in the existing source freshness stamp');
  const task = (id, extra = {}) => ({ id, provider: 'seedance', generation_mode: 'all_in_one_reference',
    source_metadata_json: null, project_id: 'project', video_card_id: 'card', video_branch_id: 'branch',
    prompt: 'private prompt must never appear in a card', ...extra });
  const tasks = [task('ordinary'), task('preview-only'), task('ip', { provider: 'volcengine_ark' }),
    task('h3', { provider: 'h3' }), task('enhanced', { provider: 'volcengine_mediakit', generation_mode: 'enhance_video' }),
    task('private', { source_metadata_json: '{"protected_module":{"kind":"multiview"}}' }),
    task('private-action', { source_metadata_json: '{"protected_module":{"kind":"multiview-action"}}' }),
    task('corrupt-private', { source_metadata_json: '{"protected_module":' })];
  const works = tasks.map(source => ({ id: `work-${source.id}`, source_kind: 'video_task', source_id: source.id }));
  works.push({ id: 'uploaded-video', source_kind: 'upload_asset', source_id: 'upload' });
  let reads = 0;
  const db = { videoTask: { findMany: async () => { reads++; return tasks; } } };
  const native = new Set(works.filter(work => work.source_id !== 'preview-only').map(work => work.id));
  const result = await projectWorkProvenance({ id: 'viewer' }, works, db, native);
  assert.equal(reads, 1, 'Video navigation uses one bounded metadata batch, without per-card reads');
  for (const id of ['ordinary', 'ip', 'h3']) {
    const projection = result.get(`work-${id}`);
    assert.equal(projection.template, null, 'Ordinary videos do not need a template to restore their inputs');
    const url = new URL(projection.videoReferenceHref, globals.window.location.origin);
    assert.equal(url.pathname, id === 'ip' ? '/generate/ip' : '/generate');
    assert.equal(url.searchParams.get('reuse_task_id'), id);
    assert.equal(url.searchParams.get('project_id'), 'project');
    assert.equal(url.searchParams.get('video_card_id'), 'card');
    assert.equal(url.searchParams.get('video_branch_id'), 'branch');
    assert.equal(url.searchParams.get('return_to'), `/works?work=work-${id}`);
    const authorized = navigation.authorizeTaskReuseHref(projection.videoReferenceHref, 'viewer');
    assert(authorized);
    const clicked = new URL(authorized, globals.window.location.origin);
    assert.equal(intents.claimTaskReuseNavigationIntent(clicked, 'other-account', 'default'), false);
    const retry = new URL(navigation.authorizeTaskReuseHref(projection.videoReferenceHref, 'viewer'), globals.window.location.origin);
    assert.equal(intents.claimTaskReuseNavigationIntent(retry, 'viewer', 'default'), true);
    assert.equal(intents.claimTaskReuseNavigationIntent(retry, 'viewer', 'default'), false, 'A navigation intent is consumed only once');
  }
  for (const id of ['preview-only', 'enhanced', 'private', 'private-action', 'corrupt-private']) {
    assert(!result.get(`work-${id}`).videoReferenceHref, `${id} must not gain an ordinary task-input reference action`);
  }
  assert(!result.get('uploaded-video').videoReferenceHref);
  assert(!JSON.stringify([...result.values()]).includes('private prompt'));
  const noAuthority = await projectWorkProvenance({ id: 'viewer' }, works, db);
  assert([...noAuthority.values()].every(item => !item.videoReferenceHref), 'Missing native authority does not grant an input action');
  assert.equal(returns.sanitizeOptionalReturnTo('/works?medium=video&work=work-ordinary'), '/works?medium=video&work=work-ordinary');
  assert.equal(returns.taskReturnLabel('/works?work=work-ordinary'), '返回作品广场');
  assert.equal(returns.sanitizeOptionalReturnTo('//outside.invalid/works'), null);
  console.log('Works video reference engineering checks passed: native authority, private exclusions, routing, explicit click and return target.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
