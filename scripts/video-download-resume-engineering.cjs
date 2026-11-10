const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const ts = require('typescript');
const root = process.env.ENGINEERING_SOURCE_ROOT || process.cwd();
const source = ts.createSourceFile('cache.ts', fs.readFileSync(path.join(root, 'src/lib/video/local-cache.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['createDownloadTimeoutError', 'readWithTimeout', 'writeResponseToFile'];
const declarations = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
assert.equal(declarations.length, names.length);
const code = ts.transpileModule(declarations.map(n => n.getText(source).replace(/^export /, '')).join('\n') + '\nglobalThis.save = writeResponseToFile;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const bytes = Buffer.alloc(262144, 31), etag = '"fixture-original"';
const headers = { etag, 'accept-ranges': 'bytes', 'content-length': String(bytes.length) };
let validated = 0;
const sandbox = { ...fsp, constants: fs.constants, createWriteStream: fs.createWriteStream, once, Buffer, Response,
  process, Date, setTimeout, clearTimeout, DOWNLOAD_TIMEOUT_MS: 1000, VIDEO_SAVE_IDLE_TIMEOUT_MS: 100,
  validateLocalMp4: async file => { validated++; assert.deepEqual(await fsp.readFile(file), bytes); } };
vm.runInNewContext(code, sandbox);
(async () => {
 const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'video-resume-engineering-'));
 const checks = [];
 try {
  const target = path.join(dir, 'original.mp4'), partial = path.join(dir, 'private.part');
  let pulls = 0;
  const broken = new Response(new ReadableStream({ async pull(controller) {
   if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 65536));
   else { await new Promise(r => setTimeout(r, 20)); controller.error(new Error('synthetic connection lost')); }
  } }), { headers });
  await assert.rejects(sandbox.save(broken, target, bytes.length, 1000, { resume: { path: partial }, validateMp4: true }));
  assert.equal(fs.existsSync(target), false);
  assert.equal((await fsp.stat(partial)).size, 65536, 'A failed transfer must retain its verified prefix privately');
  assert.equal((await fsp.stat(partial)).mode & 0o077, 0);
  checks.push('lost_connection_keeps_prefix_without_publishing_an_incomplete_original');
  let ranged = 0;
  const resume = { path: partial, fetchRange: async (offset, match) => {
   ranged++; assert.equal(offset, 65536); assert.equal(match, etag);
   return new Response(bytes.subarray(offset), { status: 206, headers: { ...headers, 'content-length': String(bytes.length - offset), 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } });
  } };
  const received = await sandbox.save(new Response(bytes, { headers }), target, bytes.length, 1000, { resume, validateMp4: true });
  assert.equal(received, bytes.length); assert.equal(ranged, 1); assert.equal(validated, 1);
  assert.deepEqual(await fsp.readFile(target), bytes); assert.equal(fs.existsSync(partial), false); assert.equal(fs.existsSync(partial + '.json'), false);
  checks.push('retry_fetches_only_the_remaining_range_then_validates_and_publishes_exact_original_bytes');
  async function checkpoint() { await fsp.writeFile(partial, bytes.subarray(0, 65536), { mode: 0o600 }); await fsp.writeFile(partial + '.json', JSON.stringify({ etag, bytes: bytes.length })); }
  for (const change of [{ etag: '"changed"' }, { 'content-range': 'bytes 1-262143/262144' }, { 'content-length': '7' }]) {
   await checkpoint(); let publishes = 0;
   await assert.rejects(sandbox.save(new Response(bytes, { headers }), path.join(dir, 'changed.mp4'), bytes.length, 1000,
    { resume: { path: partial, fetchRange: async () => new Response(bytes.subarray(65536), { status: 206, headers: { ...headers, 'content-length': String(bytes.length - 65536), 'content-range': `bytes 65536-${bytes.length - 1}/${bytes.length}`, ...change } }) }, publish: async () => { publishes++; } }), /VIDEO_RESUME_ENTITY_CHANGED/);
   assert.equal(publishes, 0); assert.equal(fs.existsSync(partial), false);
  }
  checks.push('changed_etag_wrong_offset_or_length_never_append_or_publish');
  await checkpoint();
  const ignored = path.join(dir, 'ignored.mp4');
  await sandbox.save(new Response(bytes, { headers }), ignored, bytes.length, 1000, { resume: { path: partial, fetchRange: async () => new Response(bytes, { headers }) }, validateMp4: true });
  assert.deepEqual(await fsp.readFile(ignored), bytes);
  checks.push('ignored_range_restarts_the_complete_body_instead_of_appending_it');
  await checkpoint();
  const changed = path.join(dir, 'new-entity.mp4'); let oldRange = 0;
  await sandbox.save(new Response(bytes, { headers: { ...headers, etag: '"new-original"' } }), changed, bytes.length, 1000, { resume: { path: partial, fetchRange: async () => { oldRange++; throw new Error(); } }, validateMp4: true });
  assert.equal(oldRange, 0); assert.deepEqual(await fsp.readFile(changed), bytes);
  checks.push('a_new_entity_discards_the_old_prefix_before_recording_its_new_checkpoint');
  for (const change of [{ etag: 'W/' + etag }, { 'accept-ranges': 'none' }, { 'content-encoding': 'gzip' }]) {
   let called = 0;
   await sandbox.save(new Response(bytes, { headers: { ...headers, ...change } }), path.join(dir, 'fallback-' + checks.length + '-' + String(Object.keys(change)[0])), bytes.length, 1000, { resume: { path: partial, fetchRange: async () => { called++; } }, validateMp4: true });
   assert.equal(called, 0); assert.equal(fs.existsSync(partial), false);
  }
  checks.push('weak_validators_unsupported_ranges_and_encoded_bodies_keep_the_complete_download_path');
  await assert.rejects(sandbox.save(new Response(bytes, { headers }), path.join(dir, 'lease.mp4'), bytes.length, 1000, { resume: { path: partial }, validateMp4: true, beforePublish: async () => { throw new Error('VIDEO_SAVE_LEASE_LOST'); } }), /VIDEO_SAVE_LEASE_LOST/);
  assert.equal(fs.existsSync(path.join(dir, 'lease.mp4')), false); assert.equal(fs.existsSync(partial), false);
  checks.push('lost_ownership_prevents_publication_after_full_length_and_mp4_validation');
  const timedPath = path.join(dir, 'timed.part'); let timedPull = 0;
  const stalled = new Response(new ReadableStream({ pull(controller) { if (timedPull++ === 0) controller.enqueue(bytes.subarray(0, 65536)); else return new Promise(() => {}); } }), { headers });
  await assert.rejects(sandbox.save(stalled, path.join(dir, 'timed.mp4'), bytes.length, 50, { resume: { path: timedPath }, idleTimeoutMs: 1000 }), /0\.05/);
  assert.equal(fs.existsSync(path.join(dir, 'timed.mp4')), false); assert.equal((await fsp.stat(timedPath)).size, 65536);
  checks.push('total_transfer_timeout_keeps_progress_for_the_existing_queue_retry');
  await fsp.writeFile(partial, bytes); await fsp.writeFile(partial + '.json', JSON.stringify({ etag, bytes: bytes.length }));
  let unexpectedRange = 0;
  await sandbox.save(new Response(bytes, { headers }), path.join(dir, 'complete.mp4'), bytes.length, 1000, { resume: { path: partial, fetchRange: async () => { unexpectedRange++; } }, validateMp4: true });
  assert.equal(unexpectedRange, 0); assert.deepEqual(await fsp.readFile(path.join(dir, 'complete.mp4')), bytes);
  checks.push('complete_checkpoint_is_revalidated_and_published_without_downloading_again');

  console.log(JSON.stringify({ task: 'VID-DL02', checks, applicationDatabaseOpened: false, remoteNetworkRequests: 0, paidRequests: 0 }, null, 2));
 } finally { await fsp.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
