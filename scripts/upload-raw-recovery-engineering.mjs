// Actual raw-route/state/log functions; synthetic identity, in-memory CAS and
// upload adapter only. Never imports application Prisma or opens a socket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { File } from 'node:buffer';
import ts from 'typescript';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function declarations(source, names) {
  const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const nodes = ast.statements.filter(node => names.includes(node.name?.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.text)));
  assert.equal(nodes.length, names.length);
  return nodes.map(node => node.getFullText(ast)).join('\n');
}
function evaluate(source, imports = {}, globals = {}) {
  const exports = {};
  const context = vm.createContext({ exports, Buffer, File, Request, Response, URL, URLSearchParams,
    AbortSignal, Error, console, setTimeout, clearTimeout, ...globals,
    require(name) { assert.ok(Object.hasOwn(imports, name), 'Unapproved fixture import: ' + name); return imports[name]; } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText, context);
  return exports;
}
const base = evaluate(declarations(read('src/lib/assets/verified-upload.ts'), [
  'VerifiedUploadError', 'uploadDigest', 'assertUploadOwner', 'uploadRequestId', 'verifiedUploadFailure',
]), {}, { createHash: crypto.createHash });
const checks = [], boundaryFailures = [];
function boundary(run) {
  try { return run(); } catch (error) { boundaryFailures.push(error); throw error; }
}
const check = async (name, run) => { await run(); checks.push(name); };
const fixtureBytes = Buffer.from('synthetic-preflight-no-decoding');

function environment({ rejectDirectory = false, rejectExisting = false, preflightError, failAfterWriting = false, refuseRejectionCas = false, retiredProof = false, foreignCommittedAsset = false } = {}) {
  const rows = new Map(), receipts = new Map(), phases = [], logs = [], committedAssets = new Map(), hdRequests = [];
  let writes = 0, directoryChecks = 0, hdAssetReads = 0;
  const owner = 'isolated-upload-owner';
  const prisma = { platformSetting: {
    async findUnique({ where }) { return rows.has(where.key) ? structuredClone(rows.get(where.key)) : null; },
    async create({ data }) {
      if (rows.has(data.key)) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      rows.set(data.key, structuredClone(data)); phases.push(JSON.parse(data.value_json).phase); return data;
    },
    async updateMany({ where, data }) {
      const row = rows.get(where.key), next = JSON.parse(data.value_json);
      if (!row || row.value_json !== where.value_json || refuseRejectionCas && next.phase === 'notAccepted') return { count: 0 };
      rows.set(where.key, { ...row, ...data }); phases.push(next.phase); return { count: 1 };
    },
  }, asset: {
    findUnique: async () => null,
    async findFirst({ where, select }) {
      hdAssetReads++;
      return boundary(() => {
        assert.equal(where.id, 'isolated-asset'); assert.equal(where.owner_id, owner);
        assert.equal(where.status, 'active'); assert.equal(where.type, 'image');
        assert.deepEqual(Object.keys(select).sort(), ['id', 'original_url', 'owner_id']);
        const asset = committedAssets.get(where.id);
        return asset && asset.owner_id === where.owner_id && asset.status === where.status && asset.type === where.type
          ? { id: asset.id, owner_id: asset.owner_id, original_url: asset.original_url } : null;
      });
    },
  }, user: { findUnique: async () => ({ id: owner, status: 'active' }) },
  $transaction: async run => run(prisma) };
  const verified = { ...base, uploadIdentity: async () => ({ id: owner }),
    releaseVerifiedUpload: async () => {}, readVerifiedUploadReceipt: async (_owner, id) => receipts.get(id) || null,
    findVerifiedOwnUpload: async () => null,
    preflightVerifiedOwnUpload: async () => {
      if (preflightError) throw preflightError;
      if (rejectExisting) throw new base.VerifiedUploadError('UPLOAD_EXISTING_FILE_INVALID', '已有远程原件无法安全核实', 409);
    },
    privateUploadDirectory: async () => {
      directoryChecks++;
      if (rejectDirectory) throw new base.VerifiedUploadError('UPLOAD_PRIVATE_DIRECTORY_INVALID', '上传服务暂不可用', 503);
      return '/isolated/not-used-for-files';
    },
  };
  const metadata = { validateSiteUploadMetadata: () => null, sameOriginPublicUrlForLocalUpload: value => value, isLocalPublicUploadUrl: () => true };
  const state = evaluate(read('src/lib/assets/raw-upload-state.ts'), {
    'node:crypto': crypto, '@/lib/prisma': { prisma }, './verified-upload': verified, './site-upload': metadata,
    './public-storage': { isPubliclyReachableUrl: () => true },
    './upload-similarity': { uploadSimilarityStatus: async () => ({ state: 'disabled' }) },
    './raw-upload-recovery-proof': { readRawUploadRecoveryProof: async (_key, value) => retiredProof ? base.uploadDigest(value) : null },
  });
  const route = evaluate(read('src/app/api/assets/upload/route.ts'), {
    'next/server': { NextResponse: { json: (data, init) => Response.json(data, init) } },
    '@/lib/auth/session': { getSession: async () => ({ id: owner }) }, 'node:crypto': crypto,
    '@/lib/prisma': { prisma },
    '@/lib/assets/verified-upload': verified, '@/lib/assets/raw-upload-state': state,
    '@/lib/assets/site-upload': { ...metadata, validateSiteUploadInput: () => null, getSiteUploadKind: () => 'image',
      uploadSiteAsset: async (_bytes, _name, _mime, _size, _owner, _batch, requestId) => {
        writes++;
        if (failAfterWriting) throw new base.VerifiedUploadError('UPLOAD_PRIVATE_DIRECTORY_INVALID', '上传服务暂不可用', 503);
        committedAssets.set('isolated-asset', { id: 'isolated-asset', owner_id: foreignCommittedAsset ? 'other-owner' : owner,
          original_url: '/uploads/isolated.png', status: 'active', type: 'image' });
        return { assetId: 'isolated-asset', originalUrl: '/uploads/isolated.png', mimeType: 'image/png', upload: { requestId, verified: true } };
      } },
    '@/lib/assets/upload-log': { recordAssetUploadLog: async value => logs.push(value) },
    '@/lib/assets/direct-upload-error': evaluate(read('src/lib/assets/direct-upload-error.ts')),
    '@/lib/media/hd-derivatives': { requestHd: async (source, priority, preserveText, options, context) => boundary(() => {
      assert.equal(source, '/uploads/isolated.png'); assert.equal(priority, 0);
      assert.equal(preserveText, undefined); assert.equal(options, undefined);
      assert.equal(context.owner.kind, 'asset'); assert.equal(context.owner.id, 'isolated-asset'); assert.equal(context.owner.ownerId, owner);
      assert.equal(committedAssets.get(context.owner.id)?.owner_id, owner);
      hdRequests.push({ source, context });
    }) },
  });
  const identity = { ownerId: owner, requestId: 'isolated-original-request', hash: base.uploadDigest(fixtureBytes), fileSize: fixtureBytes.length, mimeType: 'image/png' };
  const post = nonce => route.POST(new Request('https://fixture.invalid/api/assets/upload', {
    method: 'POST', headers: { 'Content-Type': identity.mimeType, 'X-File-Size': String(identity.fileSize),
      'X-File-Name': 'fixture.png', 'X-File-Hash': identity.hash, 'X-Upload-Owner-Id': owner,
      'X-Upload-Request-Id': identity.requestId, 'X-Raw-Upload-Version': '2', 'X-Raw-Upload-Nonce': nonce }, body: fixtureBytes,
  }));
  return { state, route, identity, post, rows, receipts, phases, logs, hdRequests,
    counters: () => ({ writes, directoryChecks, hdAssetReads }) };
}

await check('preflight_rejection_retains_cause_and_current_nonce_without_file_write', async () => {
  const env = environment({ rejectDirectory: true }), prepared = await env.state.prepareRawUpload(env.identity);
  const response = await env.post(prepared.rawUpload.nonce), data = await response.json();
  assert.equal(response.status, 503); assert.equal(data.code, 'RAW_UPLOAD_NOT_ACCEPTED');
  assert.equal(data.causeCode, 'UPLOAD_PRIVATE_DIRECTORY_INVALID'); assert.equal(data.errorStage, 'private-directory');
  assert.equal(data.notAccepted, true); assert.equal(data.rawUpload.nonce, prepared.rawUpload.nonce);
  assert.deepEqual(env.phases, ['prepared', 'receiving', 'notAccepted']); assert.equal(env.counters().writes, 0); assert.equal(env.counters().hdAssetReads, 0); assert.equal(env.hdRequests.length, 0);
  assert.equal(env.logs.length, 1); assert.equal(env.logs[0].errorCode, data.causeCode);
});
await check('rejection_losing_nonce_cas_remains_unknown_not_retryable', async () => {
  const env = environment({ rejectDirectory: true, refuseRejectionCas: true }), prepared = await env.state.prepareRawUpload(env.identity);
  const response = await env.post(prepared.rawUpload.nonce), data = await response.json();
  assert.equal(response.status, 409); assert.equal(data.code, 'UPLOAD_RESULT_UNKNOWN'); assert.notEqual(data.notAccepted, true);
  assert.equal((await env.state.readRawUploadState(env.identity)).phase, 'receiving'); assert.equal(env.counters().writes, 0);
});
await check('post_writing_recheck_failure_cannot_unlock_and_same_request_repost_is_rejected', async () => {
  const env = environment({ failAfterWriting: true }), prepared = await env.state.prepareRawUpload(env.identity);
  const first = await env.post(prepared.rawUpload.nonce), firstData = await first.json();
  assert.equal(first.status, 503); assert.equal(firstData.code, 'UPLOAD_PRIVATE_DIRECTORY_INVALID');
  assert.equal(firstData.errorStage, 'writing'); assert.notEqual(firstData.notAccepted, true);
  assert.equal((await env.state.readRawUploadState(env.identity)).phase, 'writing');
  const second = await env.post(prepared.rawUpload.nonce), data = await second.json();
  assert.equal(second.status, 409); assert.equal(data.code, 'UPLOAD_RESULT_UNKNOWN'); assert.equal(env.counters().writes, 1);
  await assert.rejects(env.state.transitionRawUpload(env.identity, prepared.rawUpload.nonce, 'writing', 'notAccepted'));
  assert.equal((await env.state.readRawUploadState(env.identity)).phase, 'writing');
});
await check('known_existing_asset_preflight_rejection_is_retryable_only_with_current_receiving_cas', async () => {
  for (const refuseRejectionCas of [false, true]) {
    const env = environment({ rejectExisting: true, refuseRejectionCas });
    const prepared = await env.state.prepareRawUpload(env.identity);
    const response = await env.post(prepared.rawUpload.nonce), data = await response.json();
    assert.equal(data.errorStage, 'existing-asset-preflight');
    assert.equal(data.code, refuseRejectionCas ? 'UPLOAD_RESULT_UNKNOWN' : 'RAW_UPLOAD_NOT_ACCEPTED');
    assert.equal((await env.state.readRawUploadState(env.identity)).phase, refuseRejectionCas ? 'receiving' : 'notAccepted');
    assert.equal(env.counters().writes, 0);
    if (!refuseRejectionCas) assert.equal(data.causeCode, 'UPLOAD_EXISTING_FILE_INVALID');
  }
});
await check('generic_preflight_failure_is_no_write_rejection_but_cas_loss_stays_unknown', async () => {
  for (const [preflightError, causeCode] of [
    [new Error('Synthetic generic failure with https://synthetic.invalid/?secret=x'), 'UPLOAD_PREFLIGHT_FAILED'],
    [Object.assign(new Error('Synthetic HEAD timeout'), { name: 'TimeoutError' }), 'TimeoutError'],
    [Object.assign(new Error('Synthetic HEAD not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }), 'HTTP_404'],
  ]) for (const refuseRejectionCas of [false, true]) {
    const env = environment({ preflightError, refuseRejectionCas });
    const prepared = await env.state.prepareRawUpload(env.identity), response = await env.post(prepared.rawUpload.nonce), data = await response.json();
    assert.equal(data.code, refuseRejectionCas ? 'UPLOAD_RESULT_UNKNOWN' : 'RAW_UPLOAD_NOT_ACCEPTED');
    assert.equal((await env.state.readRawUploadState(env.identity)).phase, refuseRejectionCas ? 'receiving' : 'notAccepted');
    assert.equal(env.counters().writes, 0); assert.ok(!JSON.stringify(data).includes('secret'));
    if (!refuseRejectionCas) assert.equal(data.causeCode, causeCode);
  }
});
await check('safe_retry_rotates_original_nonce_and_old_nonce_cannot_write', async () => {
  const env = environment({ rejectDirectory: true }), prepared = await env.state.prepareRawUpload(env.identity);
  await env.post(prepared.rawUpload.nonce);
  const next = await env.state.prepareRawUpload(env.identity, prepared.rawUpload.nonce);
  assert.notEqual(next.rawUpload.nonce, prepared.rawUpload.nonce); assert.equal(next.rawUpload.requestId, env.identity.requestId);
  const stale = await env.post(prepared.rawUpload.nonce);
  assert.equal(stale.status, 409); assert.equal(env.counters().writes, 0);
});
await check('competing_same_nonce_cannot_dispatch_twice', async () => {
  const env = environment(), prepared = await env.state.prepareRawUpload(env.identity);
  const responses = await Promise.all([env.post(prepared.rawUpload.nonce), env.post(prepared.rawUpload.nonce)]);
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]); assert.equal(env.counters().writes, 1);
  assert.equal((await env.state.readRawUploadState(env.identity)).phase, 'completed');
});
await check('completed_original_receipt_returns_without_directory_or_new_dispatch', async () => {
  const env = environment({ rejectDirectory: true });
  env.receipts.set(env.identity.requestId, { asset: { id: 'original-asset', original_url: '/uploads/original.png',
    file_size: env.identity.fileSize, mime_type: env.identity.mimeType, hash: env.identity.hash }, reused: true, proof: { version: 'original-version' } });
  const response = await env.post('a'.repeat(48)), data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.asset.id, 'original-asset');
  assert.equal(env.counters().writes, 0); assert.equal(env.counters().directoryChecks, 0);
  assert.equal(env.counters().hdAssetReads, 0); assert.equal(env.hdRequests.length, 0);
});
await check('successful_raw_image_leaves_hd_registration_to_shared_committed_upload', async () => {
  const env = environment(), prepared = await env.state.prepareRawUpload(env.identity);
  const response = await env.post(prepared.rawUpload.nonce);
  await Promise.resolve();
  assert.equal(response.status, 200); assert.equal(env.counters().writes, 1);
  // The actual shared upload hook and fresh ownership checks are exercised by
  // hd-registration-engineering; this route must not duplicate that work.
  assert.equal(env.counters().hdAssetReads, 0); assert.equal(env.hdRequests.length, 0);
  const revoked = environment({ foreignCommittedAsset: true }), original = await revoked.state.prepareRawUpload(revoked.identity);
  const delivered = await revoked.post(original.rawUpload.nonce);
  await Promise.resolve();
  assert.equal(delivered.status, 200, 'Unavailable HD context cannot undo an accepted upload');
  assert.equal(revoked.counters().writes, 1); assert.equal(revoked.counters().hdAssetReads, 0);
  assert.equal(revoked.hdRequests.length, 0, 'Never queue the response URL without a current owned asset');
});
await check('retired_writer_exact_proof_rotates_nonce_without_upload_and_stale_writer_is_rejected', async () => {
  const env = environment({ failAfterWriting: true, retiredProof: true });
  const prepared = await env.state.prepareRawUpload(env.identity);
  await env.post(prepared.rawUpload.nonce);
  const token = await env.state.rawUploadRecoveryToken(env.identity);
  assert.match(token, /^[a-f0-9]{64}$/);
  const before = env.counters().writes;
  const result = await env.state.recoverRetiredRawUpload(env.identity, token);
  assert.equal(result.rawUpload.phase, 'notAccepted');
  assert.notEqual(result.rawUpload.nonce, prepared.rawUpload.nonce);
  assert.equal(env.counters().writes, before);
  const stale = await env.post(prepared.rawUpload.nonce);
  assert.equal(stale.status, 409); assert.equal(env.counters().writes, before);
  await assert.rejects(() => env.state.recoverRetiredRawUpload(env.identity, token));
});
await check('unknown_without_retired_writer_proof_stays_unknown_even_with_no_asset', async () => {
  const env = environment({ failAfterWriting: true });
  const prepared = await env.state.prepareRawUpload(env.identity); await env.post(prepared.rawUpload.nonce);
  assert.equal(await env.state.rawUploadRecoveryToken(env.identity), null);
  await assert.rejects(() => env.state.recoverRetiredRawUpload(env.identity, 'a'.repeat(64)));
  assert.equal((await env.state.readRawUploadState(env.identity)).phase, 'writing');
});
await check('actual_retired_proof_reader_requires_exact_key_state_and_trusted_complete_drain_evidence', async () => {
  const key = 'raw_upload_attempt_v2:synthetic-owner:synthetic-request';
  const value = JSON.stringify({ nonce: 'synthetic-only', phase: 'writing' });
  const digest = base.uploadDigest(value);
  let entries = [{ key, stateSha256: digest, sameOwnerAsset: true }];
  let directoryMode = 0o755, fileMode = 0o644, uid = 0, symlink = false, replaced = false, closed = 0;
  let evidence = { schema: 'raw-upload-retired-writer-proof.v1', oldWritersDrained: true,
    unidentifiedStagingFiles: 0, drainReceiptSha256: 'a'.repeat(64) };
  const proof = evaluate(read('src/lib/assets/raw-upload-recovery-proof.ts'), {
    'node:crypto': crypto,
    'node:fs/promises': {
      async lstat(name) { return { isDirectory: () => !name.endsWith('.json'), uid, mode: name.endsWith('.json') ? fileMode : directoryMode, ino: replaced ? 2 : 1 }; },
      async realpath(name) { return symlink ? name + '-untrusted' : name; },
      async open() { return { stat: async () => ({ isFile: () => true, uid, mode: fileMode, size: 100, ino: 1 }),
        readFile: async () => JSON.stringify({ ...evidence, entries }), close: async () => { closed++; } }; },
    },
  }, { process: { platform: 'linux' } });
  assert.equal(await proof.readRawUploadRecoveryProof(key, value), digest);
  assert.equal(await proof.readRawUploadRecoveryProof(key + '-other', value), null);
  assert.equal(await proof.readRawUploadRecoveryProof(key, value + ' '), null);
  entries = [{ key, stateSha256: digest, noAssetOrReceipt: true, noPublishedFile: false }];
  assert.equal(await proof.readRawUploadRecoveryProof(key, value), null);
  entries[0].noPublishedFile = true;
  assert.equal(await proof.readRawUploadRecoveryProof(key, value), digest);
  entries = [];
  assert.equal(await proof.readRawUploadRecoveryProof(key, value), null);
  entries = [{ key, stateSha256: digest, sameOwnerAsset: true }];
  for (const patch of [{ oldWritersDrained: false }, { unidentifiedStagingFiles: 1 }, { drainReceiptSha256: '' }, { schema: 'other' }]) {
    const original = evidence; evidence = { ...evidence, ...patch };
    assert.equal(await proof.readRawUploadRecoveryProof(key, value), null); evidence = original;
  }
  directoryMode = 0o775; assert.equal(await proof.readRawUploadRecoveryProof(key, value), null); directoryMode = 0o755;
  fileMode = 0o664; assert.equal(await proof.readRawUploadRecoveryProof(key, value), null); fileMode = 0o644;
  uid = 1; assert.equal(await proof.readRawUploadRecoveryProof(key, value), null); uid = 0;
  symlink = true; assert.equal(await proof.readRawUploadRecoveryProof(key, value), null); symlink = false;
  replaced = true; assert.equal(await proof.readRawUploadRecoveryProof(key, value), null);
  assert.ok(closed > 0);
});
await check('existing_safe_log_records_only_request_digest_and_sanitized_fields', async () => {
  let saved;
  const log = evaluate(read('src/lib/assets/upload-log.ts'), {
    path, 'node:crypto': crypto, '@/lib/prisma': { prisma: { operationLog: { create: async value => { saved = value.data; } } } },
  });
  const requestId = 'isolated-original-private-id';
  await log.recordAssetUploadLog({ operatorId: 'isolated-owner', requestId, stage: 'raw', status: 'failed',
    errorCode: 'UPLOAD_PRIVATE_DIRECTORY_INVALID', errorStage: 'private-directory',
    errorMessage: 'service unavailable https://fixture.invalid/?token=secret' });
  const detail = JSON.parse(saved.detail);
  assert.equal(detail.requestDigest, crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 16));
  assert.equal(detail.errorStage, 'private-directory'); assert.ok(!saved.detail.includes(requestId));
  assert.ok(!saved.detail.includes('secret')); assert.ok(!saved.detail.includes('https://'));
});
assert.equal(boundaryFailures.length, 0, 'A caught route/HD adapter assertion must still fail this fixture');
console.log('UPLOAD_RAW_ENGINEERING=' + JSON.stringify({ completed: true, checks,
  method: 'Actual candidate route/state/log modules; isolated in-memory CAS and synthetic upload adapter. Not media decoding, real auth or production upload acceptance.',
  forbiddenCalls: { network: 0, productionWrites: 0, productionDatabase: 0, supplier: 0, paid: 0, browser: 0 } }));
