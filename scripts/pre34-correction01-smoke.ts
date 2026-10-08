import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function functions(file: string, names: string[]) {
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Map<string, string>();
  function visit(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of names) assert.ok(found.has(name), `missing actual ${file}:${name}`);
  return ts.transpileModule(names.map(name => found.get(name)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

class AuthError extends Error { constructor(message: string, public status: number) { super(message); } }
async function textAuthorization() {
  const docNames = ['CanvasDocumentError', 'assertProject', 'assertDocument', 'assertCanAccessCanvasDocument', 'assertCanEditCanvasDocument'];
  const guardSource = functions('src/lib/canvas-documents.ts', docNames);
  const file = 'src/app/api/tools/ultimate-canvas/generate/route.ts';
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const route = ts.transpileModule(ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  for (const fixture of [
    { name: 'admin owner no card', role: 'admin', status: 503, reached: true },
    { name: 'internal owner no card', role: 'member', status: 503, reached: true },
    { name: 'wrong requested project', project: 'other', status: 400 },
    { name: 'wrong owner including admin', owner: 'other', status: 403 },
    { name: 'archived canvas', docStatus: 'archived', status: 409 },
    { name: 'deleted canvas', docStatus: 'deleted', status: 404 },
    { name: 'revoked project generation access', canGenerate: false, status: 403 },
    { name: 'external user', role: 'external', status: 403 },
    { name: 'no canvas or card non-admin', role: 'member', document: false, status: 400 },
    { name: 'card belongs to another project', cardProject: 'other', project: null, status: 400 },
    { name: 'owner personal document no default project', docProject: null, project: null, status: 503, reached: true },
  ] as Array<Record<string, any>>) {
    let settingsReads = 0, providerCalls = 0;
    const user = { id: 'owner', role: fixture.role || 'admin' };
    const doc = { id: 'canvas-fixture', owner_user_id: fixture.owner || 'owner', project_id: 'docProject' in fixture ? fixture.docProject : 'project', status: fixture.docStatus || 'active' };
    const exports: any = {};
    const context: any = { exports, AuthError, console: { warn() {} },
      assertInternalOnly: (value: any) => { if (value.role === 'external') throw new AuthError('external', 403); },
      prisma: { canvasDocument: { findUnique: async () => doc }, videoCard: { findUnique: async () => ({ id: 'card', project_id: fixture.cardProject }) }, operationLog: { create: async () => {} } },
      getProjectAccess: async (_user: any, id: string) => ({ project: { id }, canView: true, canGenerate: fixture.canGenerate !== false }),
      getProjectForGeneration: async (_user: any, id: string) => { assert.ok(id, 'must never create a default project'); return { id }; },
      assertCanGenerateInVideoCard: async () => {}, getSession: async () => user,
      NextResponse: { json: (body: any, options: any = {}) => ({ body, status: options.status || 200 }) },
      getMuskApiSettings: async () => { settingsReads++; return {}; }, isMuskApiReady: () => false,
      createMuskChatCompletion: async () => { providerCalls++; throw Error('Provider forbidden'); },
      isStudioTextModel: () => true,
    };
    runInNewContext(guardSource + '\n' + route, context);
    const response = await exports.POST({ json: async () => ({ kind: 'script', nodeId: 'node-1', prompt: '15秒，3个镜头，每镜头5秒',
      canvas_document_id: fixture.document === false ? null : doc.id,
      project_id: 'project' in fixture ? fixture.project : 'project', video_card_id: fixture.cardProject ? 'card' : null }) });
    assert.equal(response.status, fixture.status, fixture.name);
    assert.equal(settingsReads, fixture.reached ? 1 : 0, fixture.name + ': guard before Provider settings');
    assert.equal(providerCalls, 0);
  }
}

function authoredTextDomAndPersistence() {
  const app = 'public/tools/ultimate-canvas/app.js';
  const editor = { textContent: '手写正文\n第二行 <不是HTML>' };
  const body: any = { innerHTML: '' };
  const nodeEl = { querySelector: (selector: string) => selector === '.node-text-content' ? editor : selector === '.node-body' ? body : null };
  const context: any = { exports: {}, CSS: { escape: (id: string) => id }, document: { querySelector: () => nodeEl },
    textFrom: () => '', activeTabText: () => '', contextRulesForNode: () => '',
    escapeHtml: (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  runInNewContext(functions(app, ['collectNodePrompt', 'syncNodeDataFromDom', 'renderTextNodeBody']) + '\nexports.sync=syncNodeDataFromDom; exports.render=renderTextNodeBody;', context);
  const node: any = { id: 'a', type: 'text', x: 0, y: 0, data: { generatedText: 'Provider原结果', generationResult: { id: 'paid-output' }, generationStatus: 'succeeded' } };
  context.exports.sync('a', node);
  assert.equal(node.data.authoredText, editor.textContent);
  assert.equal(node.data.generatedText, 'Provider原结果', 'manual edit never changes Provider output truth');
  context.exports.render(nodeEl, JSON.parse(JSON.stringify(node)));
  assert.ok(body.innerHTML.includes('手写正文\n第二行 &lt;不是HTML&gt;'));
  editor.textContent = ''; context.exports.sync('a', node); context.exports.render(nodeEl, node);
  assert.equal(node.data.authoredText, '', 'an explicit empty edit is not replaced by generated text');
  assert.ok(!body.innerHTML.includes('Provider原结果'));

  const names = ['CanvasDocumentError', 'invalid', 'object', 'id', 'checkJson', 'parseCanvasSnapshot'];
  const server: any = { exports: {}, AuthError, Buffer, MAX_CANVAS_BYTES: 2 * 1024 * 1024 };
  runInNewContext(functions('src/lib/canvas-documents.ts', names), server);
  node.data.authoredText = '复制保存的手写输入';
  const input = { schema: 'ultimate_canvas.v1', context: { project_id: 'project' }, canvas: { nodes: [node], connections: [] } };
  const stored = server.exports.parseCanvasSnapshot(JSON.stringify(input), 'project', true);
  assert.equal(stored.canvas.nodes[0].data.authoredText, node.data.authoredText);
  assert.equal(stored.canvas.nodes[0].data.generationResult.id, 'paid-output', 'ordinary save retains real runtime; copy tests separately strip it');
  context.exports.render(nodeEl, stored.canvas.nodes[0]);
  assert.ok(body.innerHTML.includes(node.data.authoredText));
}

function libraryDetachedFocus() {
  let focused = 0, previousFocused = 0;
  const liveTrigger = { isConnected: true, disabled: false, closest: () => null, focus: () => focused++ };
  const root = { hidden: false };
  const context: any = { exports: {}, root, dialog: { open: false }, hideTimeBubble() {}, dismissedTimeTrigger: null,
    clearTimeout() {}, clearInterval() {}, timer: null, relativeTimeTimer: null, sequence: 0, loading: false,
    document: { body: { classList: { remove() {} } } }, backgroundInert: new Map(),
    previousFocus: { isConnected: false, focus: () => previousFocused++ }, options: { getReturnFocusTarget: () => liveTrigger } };
  runInNewContext(functions('public/tools/ultimate-canvas/document-library.js', ['closeLibraryLayer']) + '\nexports.close=closeLibraryLayer;', context);
  assert.equal(context.exports.close(), true); assert.equal(root.hidden, true);
  assert.equal(focused, 1); assert.equal(previousFocused, 0);
  root.hidden = false; context.previousFocus = { ...liveTrigger, focus: () => previousFocused++ };
  context.exports.close(); assert.equal(previousFocused, 1, 'a still-live original trigger wins');
}

async function main() {
  await textAuthorization(); authoredTextDomAndPersistence(); libraryDetachedFocus();
  const context: any = { exports: {} };
  runInNewContext(functions('src/app/story-studio/story-studio.tsx', ['textRequestFailureState']) + '\nexports.classify=textRequestFailureState;', context);
  assert.equal(context.exports.classify({ status: 400 }, ''), 'rejected');
  assert.equal(context.exports.classify({ status: 403 }, ''), 'rejected');
  assert.equal(context.exports.classify(new Error('lost connection'), ''), 'unconfirmed');
  assert.equal(context.exports.classify({ status: 502 }, 'returned but invalid JSON'), 'review');
  console.log('PRE34 correction01: actual route + owner/project guards, DOM input/save/reopen, detached focus passed offline; no DB/network/Provider/browser');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
