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
const checks = [];
const check = async (name, run) => { await run(); checks.push(name); };
const fixtureBytes = Buffer.from('synthetic-preflight-no-decoding');

function environment({ rejectDirectory = false, failAfterWriting = false, refuseRejectionCas = false } = {}) {
  const rows = new Map(), receipts = new Map(), phases = [], logs = [];
  let writes = 0, directoryChecks = 0;
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
  } };
  const verified = { ...base, uploadIdentity: async () => ({ id: owner }),
    releaseVerifiedUpload: async () => {}, readVerifiedUploadReceipt: async (_owner, id) => receipts.get(id) || null,
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
  });
  const route = evaluate(read('src/app/api/assets/upload/route.ts'), {
    'next/server': { NextResponse: { json: (data, init) => Response.json(data, init) } },
    '@/lib/auth/session': { getSession: async () => ({ id: owner }) }, 'node:crypto': crypto,
    '@/lib/assets/verified-upload': verified, '@/lib/assets/raw-upload-state': state,
    '@/lib/assets/site-upload': { ...metadata, validateSiteUploadInput: () => null, getSiteUploadKind: () => 'image',
      uploadSiteAsset: async (_bytes, _name, _mime, _size, _owner, _batch, requestId) => {
        writes++;
        if (failAfterWriting) throw new base.VerifiedUploadError('UPLOAD_PRIVATE_DIRECTORY_INVALID', '上传服务暂不可用', 503);
        return { assetId: 'isolated-asset', originalUrl: '/uploads/isolated.png', mimeType: 'image/png', upload: { requestId, verified: true } };
      } },
    '@/lib/assets/upload-log': { recordAssetUploadLog: async value => logs.push(value) },
    '@/lib/media/hd-derivatives': { requestHd: async () => {} },
  });
  const identity = { ownerId: owner, requestId: 'isolated-original-request', hash: base.uploadDigest(fixtureBytes), fileSize: fixtureBytes.length, mimeType: 'image/png' };
  const post = nonce => route.POST(new Request('https://fixture.invalid/api/assets/upload', {
    method: 'POST', headers: { 'Content-Type': identity.mimeType, 'X-File-Size': String(identity.fileSize),
      'X-File-Name': 'fixture.png', 'X-File-Hash': identity.hash, 'X-Upload-Owner-Id': owner,
      'X-Upload-Request-Id': identity.requestId, 'X-Raw-Upload-Version': '2', 'X-Raw-Upload-Nonce': nonce }, body: fixtureBytes,
  }));
  return { state, route, identity, post, rows, receipts, phases, logs, counters: () => ({ writes, directoryChecks }) };
}

await check('preflight_rejection_retains_cause_and_current_nonce_without_file_write', async () => {
  const env = environment({ rejectDirectory: true }), prepared = await env.state.prepareRawUpload(env.identity);
  const response = await env.post(prepared.rawUpload.nonce), data = await response.json();
  assert.equal(response.status, 503); assert.equal(data.code, 'RAW_UPLOAD_NOT_ACCEPTED');
  assert.equal(data.causeCode, 'UPLOAD_PRIVATE_DIRECTORY_INVALID'); assert.equal(data.errorStage, 'private-directory');
  assert.equal(data.notAccepted, true); assert.equal(data.rawUpload.nonce, prepared.rawUpload.nonce);
  assert.deepEqual(env.phases, ['prepared', 'receiving', 'notAccepted']); assert.equal(env.counters().writes, 0);
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
console.log('UPLOAD_RAW_ENGINEERING=' + JSON.stringify({ completed: true, checks,
  method: 'Actual candidate route/state/log modules; isolated in-memory CAS and synthetic upload adapter. Not media decoding, real auth or production upload acceptance.',
  forbiddenCalls: { network: 0, productionWrites: 0, productionDatabase: 0, supplier: 0, paid: 0, browser: 0 } }));
