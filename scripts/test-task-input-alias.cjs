const assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript');
const file = 'src/lib/access/media-policy.ts', source = fs.readFileSync(file, 'utf8');
const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'decideMedia');
assert.ok(fn);
const moduleSource = ts.transpileModule(fn.getText(tree), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const rights = { view: true, use: true, copy: true, download: false, viewSource: false, edit: false };
const no = () => Object.fromEntries(Object.keys(rights).map(key => [key, false]));
const asset = { id: 'original', owner_id: 'other-owner', original_url: '/uploads/source.png', status: 'active' };
const task = { id: 'task', owner_user_id: 'borrower', user_id: 'borrower', project_id: 'project', retention_status: 'active',
  reference_image_urls: '["https://sd2.youdooart.com/uploads/source.png"]', source_metadata_json: null };
const match = where => typeof where.original_url === 'string' ? where.original_url === asset.original_url : where.original_url.in.includes(asset.original_url);
const db = { videoTask: { findUnique: async () => task }, asset: {
  findFirst: async ({ where }) => match(where) ? asset : null,
  findMany: async ({ where }) => match(where) ? [asset] : [],
}, referenceImage: { findFirst: async () => null, findMany: async () => [] } };
const globals = { active: () => true, MEDIA_TYPES: ['video-input'], MEDIA_ACTIONS: ['view-preview', 'download-original'],
  none: no, administrator: () => false, isTaskHiddenFromRegularUsers: () => false, isPrivateMultiviewTask: () => false,
  getProjectAccess: async () => ({ canView: true }), protectedSource: async () => false,
  assetRights: async () => rights, referenceContentRights: async () => rights, getReferenceImageByIdForAccess: async () => null,
  previewMime: () => 'image/png', actionRight: { 'view-preview': 'view', 'download-original': 'download' },
  siteUploadPathFromUrl: value => new URL(value, 'https://sd2.youdooart.com').pathname,
  siteUploadBaseUrls: () => ['https://sd2.youdooart.com'],
};
const mod = { exports: {} };
new Function('module', 'exports', ...Object.keys(globals), moduleSource)(mod, mod.exports, ...Object.values(globals));
(async () => {
  const ref = { type: 'video-input', id: 'task--image--0' }, user = { id: 'borrower' };
  assert.equal((await mod.exports.decideMedia(user, ref, 'download-original', db)).allowed, false, 'URL alias must not turn task ownership into original rights');
  assert.equal((await mod.exports.decideMedia(user, ref, 'view-preview', db)).allowed, true);
  console.log('PASS task input URL aliases preserve source download ceiling');
})().catch(error => { console.error(error); process.exitCode = 1; });
