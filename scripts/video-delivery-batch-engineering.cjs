'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const file = path.join(process.cwd(), 'src/lib/video/delivery-worker.ts');
const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'processVideoDeliveryQueueBatch');
assert.ok(declaration);
const code = ts.transpileModule(declaration.getText(source).replace(/^export /, '') + '\nglobalThis.run = processVideoDeliveryQueueBatch;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
async function check(total, limit, fail = -1) {
 const waiting = Array.from({ length: total }, (_, index) => ({ id: 'fixture-' + index })), claimed = [], finished = [], failures = [];
 let active = 0, peak = 0, claiming = false;
 const sandbox = { defaultWorkerId: () => 'fixture-worker',
  claimNextVideoDeliveryJob: async options => { assert.equal(claiming, false, 'Claims must stay sequential'); claiming = true; assert.equal(options.workerId, 'fixture-worker'); await Promise.resolve(); const job = waiting.shift(); claiming = false; if (job) claimed.push(job); return job || null; },
  processVideoDeliveryJob: async job => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; if (job.id === 'fixture-' + fail) throw new Error('synthetic save failure'); finished.push(job); },
  failVideoDeliveryJob: async (job, error) => { assert.equal(error.message, 'synthetic save failure'); failures.push(job); } };
 vm.runInNewContext(code, sandbox, { filename: file });
 const value = await sandbox.run({ workerId: 'fixture-worker', limit });
 const count = Math.min(total, Math.max(1, Math.min(limit, 50))); assert.equal(value.processed, count); assert.equal(value.succeeded, finished.length); assert.equal(value.failed, failures.length); assert.equal(value.empty, count === 0);
 assert.equal(claimed.length, count); assert.equal(new Set(claimed).size, count); assert.equal(finished.length + failures.length, count); assert.equal(waiting.length, total - count); assert.ok(peak <= 2); return { peak, count };
}
function assetChecks() {
 const file = path.join(process.cwd(), 'src/app/assets/page.tsx');
 const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
 const effects = [];
 function visit(node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') effects.push(node.arguments[0].getText(source)); ts.forEachChild(node, visit); }
 visit(source);
 const helpers = source.statements.filter(node => ts.isFunctionDeclaration(node) && ['isFastPathAssetVideo', 'shouldShowDeliveryStage'].includes(node.name?.text)).map(node => node.getText(source)).join('\n');
 let pending;
 function findPending(node) { if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'hasPendingVideoDelivery') pending = node.getText(source); ts.forEachChild(node, findPending); }
 findPending(source); assert.ok(pending);
 for (const [provider, generationMode, key, expected] of [['seedance', 'text_to_video', 'preparing', true], ['seedance', 'text_to_video', 'ready', false], ['volcengine_ark', 'all_in_one_reference', 'preparing', false], ['seedance', 'enhance_video', 'preparing', false]]) {
  const context = { items: [{ kind: 'video', source: 'video_task', provider, generationMode, deliveryStage: { key } }] };
  vm.runInNewContext(ts.transpileModule(helpers + '\nconst ' + pending + ';globalThis.pending = hasPendingVideoDelivery;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.equal(context.pending, expected, provider + ' must follow its actual delivery path');
 }
 const polling = effects.find(text => text.includes('!hasPendingVideoDelivery'));
 const metadata = effects.find(text => text.includes('downloadUrl: latest.downloadUrl'));
 assert.ok(polling && metadata);
 for (const change of [{}, { user: null }, { isReactionView: true }, { hasPendingVideoDelivery: false }, { syncingAssets: true }, { selectionMode: true }]) {
  let ticks = 0; const callbacks = [], events = new Map();
  const context = { user: { id: 'fixture' }, isReactionView: false, hasPendingVideoDelivery: true, syncingAssets: false, selectionMode: false,
   document: { hidden: false, addEventListener: (name, action) => events.set(name, action), removeEventListener: name => events.delete(name) },
   setInterval: (action, delay) => { assert.equal(delay, 15000); callbacks.push(action); return 1; }, clearInterval: id => assert.equal(id, 1),
   setReloadToken: update => { ticks = update(ticks); }, ...change };
  vm.runInNewContext(ts.transpileModule('globalThis.begin = (' + polling + ');', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const cleanup = context.begin();
  if (Object.keys(change).length) { assert.equal(callbacks.length, 0); continue; }
  assert.equal(callbacks.length, 1); callbacks[0](); assert.equal(ticks, 1); context.document.hidden = true; callbacks[0](); assert.equal(ticks, 1);
  context.document.hidden = false; events.get('visibilitychange')(); assert.equal(ticks, 2); cleanup(); assert.equal(events.size, 0);
 }
 const current = { id: 'fixture', source: 'video_task', previewUrl: 'original-playback', downloadUrl: null };
 let value = current;
 const context = { items: [{ ...current, previewUrl: 'new-cdn', downloadUrl: '/protected-download', downloadable: true, stableDownloadReady: true, deliveryStage: { key: 'ready' }, deliveryCompletedAt: 'fixture-time' }], setActiveItem: update => { value = update(value); } };
 vm.runInNewContext(ts.transpileModule('globalThis.begin = (' + metadata + ');', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context); context.begin();
 assert.equal(value.previewUrl, current.previewUrl); assert.equal(value.downloadUrl, '/protected-download'); assert.equal(value.stableDownloadReady, true);
}
(async () => {
 assert.equal((await check(7, 5)).peak, 2, 'Two authorized saves should make progress together');
 await check(7, 5, 1); await check(0, 5); assert.equal((await check(3, 1)).peak, 1); await check(55, 500);
 assetChecks();
 console.log(JSON.stringify({ task: 'VID-DL01', checks: ['two_saves_progress_with_sequential_unique_claims', 'one_failure_keeps_the_other_save_and_original_failure_receipt', 'empty_queue_terminates', 'requested_batch_limit_is_preserved', 'existing_hard_limit_of_50_is_preserved', 'only_fast_path_pending_videos_enable_refresh', 'pending_delivery_refresh_pauses_for_hidden_selection_sync_and_stops_when_done', 'drawer_download_metadata_updates_without_replacing_playback_source'], applicationDatabaseOpened: false, paidRequests: 0, browserAcceptance: false }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
