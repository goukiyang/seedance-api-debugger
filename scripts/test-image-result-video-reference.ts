import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Executes production handoff functions with an in-memory persistence boundary.
// No HTTP, browser, production DB, provider call, or billing mutation is made.
function load(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const source = readFileSync(file, 'utf8');
  const exports: Record<string, any> = {};
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  runInNewContext(js, { exports, require: (name: string) => dependencies[name] || {}, URL, Date, process: { env: {} }, ...globals });
  return exports;
}
function ast(file: string) { return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(root); assert.ok(found, 'production expression missing'); return found;
}
const rows = new Map<string, any>(), workspaces = new Map<string, any>();
const attachments: Array<{ role: string; workspaceId: string; sourceRequestId: string }> = [];
const asset = { id: 'fixture', type: 'image', status: 'active', original_url: '/original.png', hash: 'bytes', file_size: 100, file_name: 'fixture.png', width: 512, height: 512, created_at: '2026-11-12' };
const db: any = {
  asset: { findUnique: async () => asset },
  imageStudioTask: { findFirst: async () => ({ id: 'task', status: 'succeeded', asset_id: asset.id }) },
  platformSetting: {
    findUnique: async ({ where }: any) => rows.get(where.key) || null,
    upsert: async ({ where, create }: any) => { if (!rows.has(where.key)) rows.set(where.key, { id: where.key, ...create }); },
    updateMany: async ({ where, data }: any) => { const row = rows.get(where.key); if (!row || row.value_json !== where.value_json) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
  },
  workspace: { findUnique: async ({ where }: any) => workspaces.get(where.id) || null,
    create: async ({ data }: any) => workspaces.set(data.id, { status: 'active', ...data }) },
  $transaction: async (callback: (db: any) => unknown) => callback(db),
};
const server = load('src/lib/image-result-next/server.ts', {
  'node:crypto': { createHash }, '@/lib/prisma': { prisma: db },
  '@/lib/content-reactions/content': { resolveContent: async () => ({ source: { url: asset.original_url }, summary: { downloadUrl: '/download', reuse: true } }) },
  '@/lib/assets/original-image-input': { originalImageInputUrl: async () => asset.original_url },
  '@/lib/image-studio/dimension-mismatch': { studioOutputTaskWhere: {}, studioTaskHasViewableOutput: () => true },
  '@/lib/assets/reference-import': { attachAssetToSiteReferenceImage: async (options: any) => attachments.push(options) },
});
async function main() {
  const user = { id: 'owner', account_type: 'internal' };
  const legacy = await server.createImageResultNext(user, 'asset:fixture', 'video', '/template-studio?type=image');
  const legacyRaw = rows.get(`image_result_next_v1:${legacy.receiptId}`).value_json;
  const reference = await server.createImageResultNext(user, 'asset:fixture', 'video-reference', '/template-studio?type=image');
  assert.equal(legacy.receiptId, createHash('sha256').update(JSON.stringify(['owner', 'asset:fixture', 'video'])).digest('hex'));
  assert.notEqual(reference.receiptId, legacy.receiptId); assert.notEqual(reference.workspaceTabId, legacy.workspaceTabId);
  assert.equal(reference.intent, 'video-reference'); assert.equal(reference.ready, true);
  assert.deepEqual(attachments.map(row => row.role), ['first_frame', 'reference_image']);
  assert.equal(rows.get(`image_result_next_v1:${legacy.receiptId}`).value_json, legacyRaw);
  await server.prepareVideoWorkspace(user, reference.receiptId);
  await server.createImageResultNext(user, 'asset:fixture', 'video-reference', '/template-studio?type=image');
  assert.equal(attachments.length, 2, 'accepted original receipt never attaches twice');
  assert.equal((await server.findImageResultNext(user, 'asset:fixture', 'video-reference')).receiptId, reference.receiptId);
  await assert.rejects(server.getImageResultNext({ ...user, id: 'other' }, reference.receiptId), /无权/);
  await assert.rejects(server.createImageResultNext({ ...user, account_type: 'external' }, 'asset:fixture', 'video-reference', '/template-studio'), /当前账户不能/);
  workspaces.get(`image_next_${reference.receiptId}`).owner_id = 'other';
  await assert.rejects(server.getImageResultNext(user, reference.receiptId), /原独立视频草稿/);

  const composer = ast('src/components/GenerationComposer.tsx');
  const hydration = find(composer, node => ts.isArrowFunction(node) && ts.isBlock(node.body) && node.body.statements.some(statement => ts.isVariableStatement(statement) && statement.getText(composer).includes('readImageResultVideoDraft(imageResultHandoff)'))) as ts.ArrowFunction;
  for (const [intent, draftMode, expected] of [['video-reference', null, 'all_in_one_reference'], ['video', null, 'first_last_frame'], ['video-reference', 'first_last_frame', 'first_last_frame']]) {
    let mode = '';
    const noop = () => {};
    const env = { imageResultHandoff: { intent }, preferencesReady: true, imageResultDraftReady: false,
      readImageResultVideoDraft: () => draftMode ? { settings: { generationMode: draftMode }, prompt: 'kept' } : null,
      initialSettings: null, setGenerationMode: (value: string) => { mode = value; }, setPrompt: noop,
      setRatio: noop, setDuration: noop, setResolution: noop, setGenerateAudio: noop, setReturnLastFrame: noop, setWatermark: noop,
      setSelectedModel: noop, onModelChange: noop, appliedInitialSettingsRef: { current: false }, setImageResultDraftReady: noop };
    runInNewContext(`(${hydration.getText(composer)})()`, env); assert.equal(mode, expected);
  }
  const validation = find(composer, node => ts.isIfStatement(node) && node.expression.getText(composer) === 'imageResultHandoff' && node.thenStatement.getText(composer).includes('首帧素材已改变')) as ts.IfStatement;
  const validate = (intent: string) => runInNewContext(ts.transpileModule(`(() => { ${validation.getText(composer)}; return null; })()`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, {
    imageResultHandoff: { intent }, imageResultDraftReady: true, workspace: { loading: false, assets: [{ type: 'image', role: 'reference_image' }] },
    generationMode: 'all_in_one_reference', modelOptions: [{ id: 'model' }], selectedModel: 'model', selectedProvider: 'seedance',
  });
  assert.equal(validate('video-reference'), null); assert.match(validate('video'), /请选择首尾帧/);

  const results = ast('src/components/GeneratedImageResults.tsx');
  const videoItem = find(results, node => ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(results) === 'id' && property.initializer.getText(results) === "'video'")) as ts.ObjectLiteralExpression;
  const sent: string[] = [];
  const menu = runInNewContext(ts.transpileModule(`(${videoItem.getText(results)})`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText, {
    React: { createElement: () => null }, Video: () => null, controller: { canVideo: true, videoDisabledReason: '', open: (intent: string) => sent.push(intent) },
  });
  assert.equal(menu.label, '发送视频参考图'); assert.match(menu.description, /全能参考/); assert.equal(sent.length, 0);
  menu.onSelect(); assert.deepEqual(sent, ['video-reference']);

  // The cover menu uses the server-provided capability and the existing deletion controller.
  const studio = ast('src/app/image-studio/studio.tsx');
  const deletion = find(studio, node => ts.isPropertyAssignment(node) && node.name.getText(studio) === 'onDelete' && node.initializer.getText(studio).includes('deletion.request')) as ts.PropertyAssignment;
  for (const [allowed, actorId, visible] of [[true, 'owner', true], [false, 'owner', false], [true, 'other', false]] as const) {
    let calls = 0;
    const onDelete = runInNewContext(`(${ts.transpileModule(deletion.initializer.getText(studio), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText.trim().replace(/;$/, '')})`, {
      deleteTarget: { allowed, actorId }, userId: 'owner', entry: { name: 'fixture' }, deletion: { request: () => { calls++; } },
    });
    assert.equal(typeof onDelete === 'function', visible); assert.equal(calls, 0);
    if (onDelete) { onDelete({}); assert.equal(calls, 1, 'selection invokes the existing confirmation flow'); }
  }
  const gallery = ast('src/app/image-studio/ModuleGallery.tsx');
  const actions = find(gallery, node => ts.isJsxAttribute(node) && node.name.getText(gallery) === 'actions') as ts.JsxAttribute;
  assert.ok(actions.initializer && ts.isJsxExpression(actions.initializer) && actions.initializer.expression);
  let selected = '';
  const coverActions = runInNewContext(ts.transpileModule(`(${actions.initializer.expression.getText(gallery)})`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText, {
    editable: true, React: { createElement: () => null }, ImagePlus: () => null, Trash2: () => null,
    item: { onEditCover: () => { selected = 'cover'; }, onDelete: () => { selected = 'delete'; }, deleteDisabled: false, deletePending: false },
  });
  assert.deepEqual(Array.from(coverActions, (action: any) => action.label), ['修改封面', '删除模板']);
  assert.equal(selected, ''); coverActions[0].onSelect({}); assert.equal(selected, 'cover');
  coverActions[1].onSelect({}); assert.equal(selected, 'delete'); assert.equal(coverActions[1].danger, true);
  console.log('Video reference handoff production functions, legacy isolation, saved defaults and cover deletion capability passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
