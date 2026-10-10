'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the actual leaf functions with a minimal DOM shell, not a browser/demo.
function functions(file) {
  const source = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, node.getText(tree));
    ts.forEachChild(node, visit);
  }
  visit(tree); return { source, tree, found };
}
class Element {
  constructor(tag) { this.tagName = tag; this.childNodes = []; this.dataset = {}; this.attributes = {}; this.open = false; this._text = ''; }
  set textContent(value) { this._text = String(value); this.childNodes = []; }
  get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unexpected HTML interpolation in readonly content'); }
  append(...children) { this.childNodes.push(...children); }
  replaceChildren(...children) { this._text = ''; this.childNodes = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  contains(target) { return this === target || this.childNodes.some(child => child.contains?.(target)); }
  querySelectorAll(tags) { return descendants(this).filter(child => tags.split(',').map(tag => tag.trim()).includes(child.tagName)); }
}
function descendants(node) { return node.childNodes.flatMap(child => [child, ...descendants(child)]); }
const leaf = functions('public/tools/ultimate-canvas/role-workflow.js');
const app = functions('public/tools/ultimate-canvas/app.js');
const names = ['safeContext', 'currentContext', 'contextKey', 'sameContext', 'isCurrent', 'el', 'icon', 'setIcon', 'button', 'panelMessage',
  'parseJson', 'isRecord', 'clean', 'textOf', 'numberOf', 'finiteInteger', 'formatPoints', 'formatUsdMicros', 'validId', 'copyJson', 'recordList',
  'roleConfig', 'nodeTitle', 'currentDetail', 'summaryRow', 'recordDetails', 'attachmentDescription', 'attachmentRecord', 'appendReadonlyContent',
  'showReadonlyDelivery', 'renderInputs', 'openInputDelivery', 'renderAttemptRow', 'purposeLabel', 'attemptStateLabel', 'feeLabel', 'addTime',
  'openAttempt', 'executionGate', 'apiUrl', 'attachmentRoute', 'normalizeError', 'previewAttachment'];
for (const name of names) assert.ok(leaf.found.has(name), 'Actual function ' + name);
const ctx = { userId: 'synthetic-owner', projectId: 'synthetic-project', documentId: 'synthetic-document', contextEpoch: 1, scopeKey: 'synthetic' };
const state = { ctx, sequence: 1, selectedWorkId: 'downstream-work', modalContent: null, materials: [], nodes: [],
  detail: { work: { id: 'downstream-work' }, inputs: [], attempts: [] } };
const requests = [], notices = [], attachmentViews = new WeakMap();
let response, modal, fixtureContext = ctx;
const runtime = { state, API: '/api/tools/ultimate-canvas', attachmentViews, previewControllers: new Set(),
  document: { createElement: tag => new Element(tag), createTextNode: value => ({ textContent: value, childNodes: [] }) },
  bridge: { context: () => fixtureContext, notice: message => notices.push(message), icon: () => '' },
  requestJson: async (url, options) => { requests.push({ url, method: options.method }); return response; },
  notifyBillingSettled: () => {}, openModal: (kind, content) => { modal = { kind, content }; state.modalContent = content; },
  Date, Number, JSON, Object, Set, WeakMap, URLSearchParams, AbortController, Response,
  fetch: async (url, options) => { requests.push({ url, method: options.method }); return new Response('\n fixed original file \n'); },
};
vm.createContext(runtime);
vm.runInContext(names.map(name => leaf.found.get(name)).join('\n'), runtime);
const checks = [];
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); console.error('FAIL ' + name + ': ' + error.message); }
}
async function attempt(reply) {
  state.modalContent = null;
  state.detail.attempts = [{ id: 'attempt-original' }];
  response = { attempt: { id: 'attempt-original', work_id: state.selectedWorkId, purpose: 'review', state: 'succeeded', fee_state: 'confirmed',
    request_id: 'original-request', result_json: typeof reply === 'string' ? reply : JSON.stringify(reply) } };
  const target = { dataset: { attemptId: 'attempt-original' }, disabled: false };
  await runtime.openAttempt(target); assert.equal(target.disabled, false);
  return descendants(modal.content).filter(node => node.tagName === 'pre' && node.className === 'crw-delivery-fulltext').map(node => node.textContent);
}
async function main() {
  await check('UI13 actual flat historical JSON and nested provider replies render original text safely', async () => {
    assert.deepEqual(await attempt({ text: 'Synthetic historical advice 30', recommendationOnly: true }), ['Synthetic historical advice 30']);
    assert.deepEqual(await attempt({ model: 'synthetic', content: { text: '\n original nested reply \n', items: { evidence: '<img src=x onerror=unsafe()>' } } }),
      ['\n original nested reply \n', '<img src=x onerror=unsafe()>']);
    assert.deepEqual(await attempt({ content: JSON.stringify({ text: 'Nested string content' }) }), ['Nested string content']);
    assert.deepEqual(await attempt({ text: 'Do not revive old text', content: { text: '' } }), []);
    assert.deepEqual(await attempt('{broken'), []);
    assert.ok(requests.every(request => request.method === 'GET'));
    const records = descendants(modal.content).find(node => node.tagName === 'details');
    assert.equal(records.open, false); assert.match(records.textContent, /original-request/);
  });
  await check('UI13 original attempt work identity mismatch is refused', async () => {
    response.attempt.work_id = 'another-work'; state.modalContent = null;
    await assert.rejects(runtime.openAttempt({ dataset: { attemptId: 'attempt-original' } }), /工作身份不匹配/);
  });
  await check('UI25 work-time input entry opens exact full original/items and fixed attachment without latest lookup', async () => {
    const body = 'Fixed upstream text '.repeat(100);
    state.detail.inputs = [{ sourceWorkId: 'upstream-original-work', deliveryId: 'fixed-delivery-v1', version: 1, nodeId: 'upstream-role',
      content: { text: body, items: { evidence: 'Fixed required evidence' }, attachments: [{ sourceKind: 'canvas_text', type: 'file',
        title: 'Original text file', sourceDigest: 'fixed-source-digest', url: 'https://untrusted.invalid/not-used' }] } }];
    const rendered = runtime.renderInputs(state.detail);
    const view = descendants(rendered).find(node => node.dataset?.action === 'view-input'); assert.ok(view);
    assert.equal(view.textContent, '查看上游原稿');
    const before = requests.length; runtime.openInputDelivery(view);
    assert.equal(requests.length, before); assert.equal(modal.kind, 'delivery');
    const originalText = descendants(modal.content).filter(node => node.tagName === 'pre').map(node => node.textContent);
    assert.deepEqual(originalText, [body, 'Fixed required evidence']);
    const preview = descendants(modal.content).find(node => node.dataset?.action === 'preview-attachment'); assert.ok(preview);
    const binding = attachmentViews.get(preview);
    assert.equal(binding.deliveryId, 'fixed-delivery-v1'); assert.equal(binding.index, 0);
    await runtime.previewAttachment(preview);
    assert.equal(requests.at(-1).url, '/api/tools/ultimate-canvas/role-deliveries/fixed-delivery-v1/attachments/0');
    assert.equal(requests.at(-1).method, 'GET');
    assert.equal(descendants(binding.host).find(node => node.tagName === 'pre').textContent, '\n fixed original file \n');
    const links = descendants(binding.host).filter(node => node.tagName === 'a');
    assert.equal(links.length, 2); assert.ok(links.every(link => link.href === requests.at(-1).url));
    assert.throws(() => runtime.openInputDelivery({ dataset: { ...view.dataset, deliveryId: 'latest-delivery-v2' } }), /不在当前工作输入/);
    assert.throws(() => runtime.openInputDelivery({ dataset: { ...view.dataset, sourceWorkId: 'unrelated-work' } }), /不在当前工作输入/);
    assert.throws(() => runtime.openInputDelivery({ dataset: { ...view.dataset, inputVersion: '2' } }), /不在当前工作输入/);
    assert.throws(() => runtime.attachmentRoute('https://untrusted.invalid', 0), /身份无效/);
    assert.throws(() => runtime.attachmentRoute('fixed-delivery-v1', 20), /身份无效/);
  });
  await check('UI25 denied original remains fixed and does not substitute thumbnail or current source', async () => {
    const view = descendants(runtime.renderInputs(state.detail)).find(node => node.dataset?.action === 'view-input');
    runtime.openInputDelivery(view);
    const preview = descendants(modal.content).find(node => node.dataset?.action === 'preview-attachment');
    const binding = attachmentViews.get(preview);
    runtime.fetch = async (url, options) => { requests.push({ url, method: options.method }); return new Response('denied', { status: 403 }); };
    await runtime.previewAttachment(preview);
    assert.match(binding.host.textContent, /HTTP 403/); assert.match(binding.host.textContent, /不会改用当前节点或缩略图/);
    assert.equal(descendants(binding.host).filter(node => node.tagName === 'a').length, 0);
    assert.equal(requests.at(-1).url, '/api/tools/ultimate-canvas/role-deliveries/fixed-delivery-v1/attachments/0');
  });
  await check('UX01 manual-task budget language is AI-only, accurate quote gate remains denied', () => {
    const result = runtime.executionGate({}, 'work', {});
    assert.equal(result.ready, false); assert.match(result.reason, /仅 AI 调用/); assert.match(result.reason, /人工工作可不填/);
    const calls = runtime.executionGate({}, 'work', { budget_points_limit: 0, budget_usd_micros_limit: 0 });
    assert.equal(calls.ready, false); assert.match(calls.reason, /AI 调用还需/);
    assert.equal(runtime.executionGate({}, 'work', { budget_points_limit: 1, budget_usd_micros_limit: 10000, max_calls: 1 }).ready, false);
  });
  await check('UX01 role-only time preserves existing accurate-time control and avoids zero minutes', () => {
    let now = Date.parse('2026-10-09T22:00:00Z');
    const clock = { now: () => now, parse: Date.parse };
    const timeRuntime = { Date: clock, Number, Math, escapeHtml: value => String(value), document: { createElement: () => {
      let markup = '', label;
      return { set innerHTML(value) { markup = value; const match = markup.match(/<time[^>]*>([^<]*)<\/time>/); label = match ? { textContent: match[1] } : null; },
        get innerHTML() { return label ? markup.replace(/(<time[^>]*>)[^<]*(<\/time>)/, '$1' + label.textContent + '$2') : markup; },
        querySelector: () => label };
    } } };
    vm.createContext(timeRuntime);
    vm.runInContext(app.found.get('rulesTime') + '\n' + app.found.get('roleTime'), timeRuntime);
    for (const age of [0, 44000, 45000, 59000]) {
      const stamp = new Date(now - age).toISOString(), markup = timeRuntime.roleTime(stamp);
      assert.match(markup, />刚刚<\/time>/); assert.ok(markup.includes('data-rules-time="' + stamp + '"'));
      assert.ok(markup.includes('datetime="' + stamp + '"')); assert.match(markup, /aria-label="查看准确时间"/);
    }
    assert.match(timeRuntime.roleTime(new Date(now - 60000).toISOString()), />1分钟前<\/time>/);
    assert.equal(timeRuntime.roleTime('invalid'), '');
    assert.ok(app.source.includes('renderTime: roleTime'));
  });
  await check('Static leaf action wiring uses existing exact routes, no duplicate handlers/exports or billing mutations', () => {
    assert.match(leaf.found.get('handleClickAsync'), /action === 'view-input'.*openInputDelivery/);
    assert.ok(!leaf.found.get('openInputDelivery').includes('requestJson'));
    assert.match(leaf.found.get('showReadonlyDelivery'), /appendReadonlyContent\(content, contentData, delivery.id\)/);
    assert.match(leaf.found.get('attachmentRoute'), /role-deliveries/);
    assert.ok(!leaf.found.get('previewAttachment').includes('attachment.url'));
    assert.match(leaf.source, /return \{ open, openPending, refresh, contextChanged, hasUnsaved, close \}/);
    const duplicates = [];
    function visit(node) {
      if (ts.isBlock(node) || ts.isSourceFile(node)) {
        const seen = new Set();
        for (const statement of node.statements) if (ts.isFunctionDeclaration(statement) && statement.name) {
          if (seen.has(statement.name.text)) duplicates.push(statement.name.text); seen.add(statement.name.text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(leaf.tree); assert.deepEqual(duplicates, []);
  });
  const result = { scope: 'UI13/UI25/UX01 actual extracted JS functions with DOM shell/mocked read; not Browser/layout/API/backend acceptance',
    checks, browserRuns: 0, servicesStarted: 0, productionWrites: 0, realProviderCalls: 0 };
  if (process.argv[2]) {
    const directory = path.resolve(process.argv[2]);
    if (!directory.startsWith(path.resolve('.role-tests') + path.sep)) throw new Error('Receipt path must be isolated scratch');
    const receipt = path.join(directory, 'receipt.json'); fs.writeFileSync(receipt, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log('Evidence: ' + receipt);
  }
  if (checks.some(check => !check.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
