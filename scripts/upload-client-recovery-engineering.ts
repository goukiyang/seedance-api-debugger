import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const repository = path.resolve(__dirname, '..');
const clientPath = path.join(repository, 'src/lib/http/file-upload.ts');
const pickerPath = path.join(repository, 'src/components/ResourceLibraryPicker.tsx');

function evaluate(source: string, globals: Record<string, unknown>, imports: Record<string, unknown>, label: string) {
  const exports: Record<string, any> = {};
  const context = vm.createContext({
    exports,
    File,
    Blob,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    AbortSignal,
    Error,
    console,
    setTimeout,
    clearTimeout,
    crypto: crypto.webcrypto,
    ...globals,
    require(name: string) {
      if (!Object.hasOwn(imports, name)) throw new Error(`Unapproved import: ${name}`);
      return imports[name];
    },
  });
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInContext(output, context, { filename: label });
  return exports;
}

function declarations(source: string, names: string[]) {
  const ast = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const selected = ast.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text)) return true;
    return ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text));
  });
  assert.equal(selected.length, names.length, `Expected declarations: ${names.join(', ')}`);
  return selected.map((statement) => statement.getFullText(ast)).join('\n');
}

type RawMode = 'absent' | 'writing' | 'notAccepted';
function clientHarness(initialMode: RawMode) {
  const browserStorage = new Map<string, string>();
  const calls = { get: 0, ticketPost: 0, rawPost: 0 };
  let mode: RawMode = initialMode;
  let ticketProofPhase: 'prepared' | 'writing' = 'prepared';
  let expectedIdentity: { ownerId: string; requestId: string; hash: string; fileSize: number; mimeType: string };
  let expectedNonce = '';
  const rotatedNonce = 'b'.repeat(48);
  let ticketBody: Record<string, unknown> | null = null;
  const source = `${fs.readFileSync(clientPath, 'utf8')}\nexport const engineering = { recoverRawUpload, performRawUpload, finishRawAsset };`;
  const module = evaluate(source, {
    sessionStorage: {
      getItem: (key: string) => browserStorage.get(key) ?? null,
      setItem: (key: string, value: string) => browserStorage.set(key, value),
      removeItem: (key: string) => browserStorage.delete(key),
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/assets/upload?')) {
        calls.get += 1;
        return Response.json({ rawUpload: { ...expectedIdentity, phase: mode, ...(mode === 'absent' ? {} : { nonce: expectedNonce }) } });
      }
      assert.equal(url, '/api/assets/upload-ticket');
      assert.equal(init?.method, 'POST');
      calls.ticketPost += 1;
      ticketBody = JSON.parse(String(init?.body));
      return Response.json({ rawUpload: { ...expectedIdentity, phase: ticketProofPhase, nonce: rotatedNonce } });
    },
  }, {
    './json-response': { readJsonResponse: async (response: Response) => response.json() },
    './upload-session': { uploadSession: () => ({ ownerId: 'owner-a', epoch: 7 }) },
    './upload-progress': {
      calculateUploadTimeoutMs: () => 1000,
      notifyUploadProgress: () => {},
      requestJsonWithUploadProgress: async (options: { url: string; headers: Record<string, string> }) => {
        assert.equal(options.url, '/api/assets/upload');
        assert.equal(options.headers['X-Raw-Upload-Nonce'], rotatedNonce);
        calls.rawPost += 1;
        return { ok: true, status: 200, data: { asset: {
          id: 'asset-recovered', hash: expectedIdentity.hash, fileSize: expectedIdentity.fileSize,
          mimeType: expectedIdentity.mimeType, upload: { requestId: expectedIdentity.requestId, verified: true, assetDisposition: 'new', sourceVersion: 'fixture' },
        } } };
      },
    },
  }, 'file-upload.engineering.ts');

  const makeFile = (name: string) => new File([Buffer.from(`fixture:${name}`)], name, { type: 'application/octet-stream' });
  const prime = (file: File, requestId: string, phase: 'preparing' | 'sending' | 'retryable' = 'sending') => {
    const bytes = Buffer.from(`fixture:${file.name}`);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    expectedIdentity = { ownerId: 'owner-a', requestId, hash, fileSize: file.size, mimeType: file.type };
    expectedNonce = 'a'.repeat(48);
    const key = `sd2:raw-upload:v1:${expectedIdentity.ownerId}:${hash}:${file.size}:${file.type}`;
    browserStorage.set(key, JSON.stringify({ ...expectedIdentity, version: 2, phase, ...(phase === 'preparing' ? {} : { nonce: expectedNonce }) }));
    return { key, identity: expectedIdentity };
  };
  return { module, browserStorage, calls, makeFile, prime, setMode: (next: RawMode) => { mode = next; },
    setTicketProof: (next: 'prepared' | 'writing') => { ticketProofPhase = next; }, rotatedNonce, ticket: () => ticketBody };
}

async function captureFailure(promise: Promise<unknown>) {
  try { await promise; }
  catch (error) { return error as { message: string; code?: string; causeCode?: string; stage?: string; recovery?: string }; }
  assert.fail('Expected upload failure');
}

type MultipartCompleteMode = 'network' | 'invalidJson' | 'noAsset' | 'success' | 'signFailure';
function multipartHarness(initialMode: MultipartCompleteMode) {
  const browserStorage = new Map<string, string>();
  const calls = { start: 0, sign: 0, complete: 0, abort: 0, partPut: 0 };
  let mode = initialMode;
  const ownerId = 'owner-multipart';
  const requestId = 'request-multipart-0001';
  const hash = 'c'.repeat(64);
  const uploadToken = 'multipart-token-original';
  const file = {
    name: 'large-original.mp4',
    size: 50 * 1024 * 1024 + 1,
    type: 'video/mp4',
    slice: () => new Blob([Buffer.from('part')], { type: 'video/mp4' }),
  } as unknown as File;
  const key = `sd2_multipart_upload:v2:${ownerId}:${hash}:${file.size}:${file.type}`;
  const context = { hash, width: 1920, height: 1080, durationSeconds: 4, ownerId, requestId };
  const source = `${fs.readFileSync(clientPath, 'utf8')}\nexport const multipartEngineering = { uploadWithMultipart };`;
  class ForbiddenPartRequest {
    constructor() { calls.partPut += 1; throw new Error('Unexpected multipart body upload'); }
  }
  const module = evaluate(source, {
    window: {},
    XMLHttpRequest: ForbiddenPartRequest,
    sessionStorage: {
      getItem: (storageKey: string) => browserStorage.get(storageKey) ?? null,
      setItem: (storageKey: string, value: string) => browserStorage.set(storageKey, value),
      removeItem: (storageKey: string) => browserStorage.delete(storageKey),
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/assets/multipart/start') { calls.start += 1; throw new Error('Unexpected new multipart request'); }
      if (url === '/api/assets/multipart/sign-part') {
        calls.sign += 1;
        throw new Error('分块上传签名连接中断');
      }
      if (url === '/api/assets/multipart/abort') { calls.abort += 1; return Response.json({ success: true }); }
      assert.equal(url, '/api/assets/multipart/complete');
      calls.complete += 1;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.uploadToken, uploadToken);
      assert.equal(Object.hasOwn(body, 'requestId'), false);
      assert.equal(body.ownerId, ownerId);
      if (mode === 'network') throw new Error('complete network unavailable');
      if (mode === 'invalidJson') return new Response('<html>invalid</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      if (mode === 'noAsset') return Response.json({ success: true });
      return Response.json({ success: true, asset: { id: 'asset-multipart' } });
    },
  }, {
    './json-response': { readJsonResponse: async (response: Response) => response.json() },
    './upload-session': { uploadSession: () => ({ ownerId, epoch: 11 }) },
    './upload-progress': { calculateUploadTimeoutMs: () => 1000, notifyUploadProgress: () => {}, requestJsonWithUploadProgress: async () => assert.fail('Unexpected raw upload') },
  }, 'multipart-upload.engineering.ts');
  const seed = (phase: 'uploading' | 'completing', completeParts = phase === 'completing') => browserStorage.set(key, JSON.stringify({
    hash,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    uploadToken,
    uploadId: 'multipart-id-original',
    partSize: file.size,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    parts: completeParts ? [{ partNumber: 1, eTag: 'etag-original' }] : [],
    phase,
  }));
  return { module, browserStorage, calls, file, context, key, seed, setMode: (next: MultipartCompleteMode) => { mode = next; } };
}

async function main() {
const unknown = clientHarness('writing');
const unknownFile = unknown.makeFile('unknown.bin');
const unknownReceipt = unknown.prime(unknownFile, 'request-unknown-0001');
const unknownError = await captureFailure(unknown.module.uploadFileToHistory(unknownFile, { ownerId: 'owner-a' }));
assert.equal(unknownError.recovery, 'query');
assert.equal(unknownError.stage, 'raw-writing');
assert.equal(unknown.calls.get, 1);
assert.equal(unknown.calls.ticketPost, 0);
assert.equal(unknown.calls.rawPost, 0);

const safeRetry = clientHarness('notAccepted');
const retryFile = safeRetry.makeFile('retry.bin');
const retryReceipt = safeRetry.prime(retryFile, 'request-retry-0001');
const rejected = await captureFailure(safeRetry.module.uploadFileToHistory(retryFile, { ownerId: 'owner-a' }));
assert.equal(rejected.code, 'RAW_UPLOAD_NOT_ACCEPTED');
assert.equal(rejected.recovery, 'retry');
assert.equal(safeRetry.calls.get, 1);
assert.equal(safeRetry.calls.ticketPost, 0);
assert.equal(safeRetry.calls.rawPost, 0);
const retried = await safeRetry.module.uploadFileToHistory(retryFile, { ownerId: 'owner-a' });
assert.equal(retried.id, 'asset-recovered');
assert.equal(safeRetry.calls.get, 2);
assert.equal(safeRetry.calls.ticketPost, 1);
assert.equal(safeRetry.calls.rawPost, 1);
assert.equal(safeRetry.ticket()?.previousNonce, 'a'.repeat(48));
assert.equal(safeRetry.ticket()?.requestId, retryReceipt.identity.requestId);

const preparedMismatch = clientHarness('absent');
const preparedFile = preparedMismatch.makeFile('prepared-shape.bin');
const preparedReceipt = preparedMismatch.prime(preparedFile, 'request-prepared-shape-0001', 'preparing');
preparedMismatch.setTicketProof('writing');
const preparedError = await captureFailure(preparedMismatch.module.uploadFileToHistory(preparedFile, { ownerId: 'owner-a' }));
assert.equal(preparedError.code, 'RAW_UPLOAD_RESULT_UNKNOWN');
assert.equal(preparedError.stage, 'raw-prepare');
assert.equal(preparedError.recovery, 'query');
assert.equal(preparedMismatch.calls.get, 1);
assert.equal(preparedMismatch.calls.ticketPost, 1);
assert.equal(preparedMismatch.calls.rawPost, 0);
assert.ok(preparedMismatch.browserStorage.has(preparedReceipt.key));

const identityMismatch = clientHarness('writing');
const identityFile = identityMismatch.makeFile('identity-mismatch.bin');
const identityReceipt = identityMismatch.prime(identityFile, 'request-identity-mismatch-0001');
const identityError = await captureFailure(Promise.resolve().then(() => identityMismatch.module.engineering.finishRawAsset(
  identityFile,
  { ownerId: identityReceipt.identity.ownerId, hash: identityReceipt.identity.hash },
  identityReceipt.identity,
  { id: 'asset-wrong', hash: 'd'.repeat(64), fileSize: identityFile.size, mimeType: identityFile.type,
    upload: { requestId: identityReceipt.identity.requestId, verified: true, assetDisposition: 'new', sourceVersion: 'fixture' } },
)));
assert.equal(identityError.code, 'RAW_UPLOAD_RESULT_UNKNOWN');
assert.equal(identityError.stage, 'raw-verify');
assert.equal(identityError.recovery, 'query');
assert.ok(identityMismatch.browserStorage.has(identityReceipt.key));

const completing = multipartHarness('network');
completing.seed('completing');
const completionNetworkError = await captureFailure(completing.module.multipartEngineering.uploadWithMultipart(
  completing.file, completing.context, 'invalid multipart response', undefined, true,
));
assert.equal(completionNetworkError.code, 'MULTIPART_UPLOAD_RESULT_UNKNOWN');
assert.equal(completionNetworkError.stage, 'multipart-complete');
assert.equal(completionNetworkError.recovery, 'query');
assert.ok(completing.browserStorage.has(completing.key));
assert.deepEqual(completing.calls, { start: 0, sign: 0, complete: 1, abort: 0, partPut: 0 });
completing.setMode('success');
const completedAsset = await completing.module.multipartEngineering.uploadWithMultipart(
  completing.file, completing.context, 'invalid multipart response', undefined, true,
);
assert.equal(completedAsset.id, 'asset-multipart');
assert.deepEqual(completing.calls, { start: 0, sign: 0, complete: 2, abort: 0, partPut: 0 });
assert.equal(completing.browserStorage.has(completing.key), false);

const invalidCompletion = multipartHarness('invalidJson');
invalidCompletion.seed('completing');
const invalidCompletionError = await captureFailure(invalidCompletion.module.multipartEngineering.uploadWithMultipart(
  invalidCompletion.file, invalidCompletion.context, 'invalid multipart response', undefined, true,
));
assert.equal(invalidCompletionError.recovery, 'query');
assert.equal(invalidCompletionError.stage, 'multipart-complete');
assert.deepEqual(invalidCompletion.calls, { start: 0, sign: 0, complete: 1, abort: 0, partPut: 0 });
assert.ok(invalidCompletion.browserStorage.has(invalidCompletion.key));

const missingCompletionAsset = multipartHarness('noAsset');
missingCompletionAsset.seed('completing');
const missingAssetError = await captureFailure(missingCompletionAsset.module.multipartEngineering.uploadWithMultipart(
  missingCompletionAsset.file, missingCompletionAsset.context, 'invalid multipart response', undefined, true,
));
assert.equal(missingAssetError.code, 'MULTIPART_UPLOAD_RESULT_UNKNOWN');
assert.equal(missingAssetError.recovery, 'query');
assert.deepEqual(missingCompletionAsset.calls, { start: 0, sign: 0, complete: 1, abort: 0, partPut: 0 });

const resumable = multipartHarness('signFailure');
resumable.seed('uploading');
const resumeError = await captureFailure(resumable.module.multipartEngineering.uploadWithMultipart(
  resumable.file, resumable.context, 'invalid multipart response', undefined, true,
));
assert.equal(resumeError.code, 'MULTIPART_UPLOAD_RESUMABLE');
assert.equal(resumeError.stage, 'multipart-upload');
assert.equal(resumeError.recovery, 'resume');
assert.deepEqual(resumable.calls, { start: 0, sign: 1, complete: 0, abort: 0, partPut: 0 });
assert.ok(resumable.browserStorage.has(resumable.key));

const incompleteCompletion = multipartHarness('success');
incompleteCompletion.seed('completing', false);
const incompleteCompletionMarker = incompleteCompletion.browserStorage.get(incompleteCompletion.key);
const incompleteCompletionError = await captureFailure(incompleteCompletion.module.multipartEngineering.uploadWithMultipart(
  incompleteCompletion.file, incompleteCompletion.context, 'invalid multipart response', undefined, true,
));
assert.equal(incompleteCompletionError.code, 'MULTIPART_UPLOAD_STATE_INCOMPLETE');
assert.equal(incompleteCompletionError.stage, 'multipart-complete');
assert.equal(incompleteCompletionError.recovery, 'none');
assert.deepEqual(incompleteCompletion.calls, { start: 0, sign: 0, complete: 0, abort: 0, partPut: 0 });
assert.equal(incompleteCompletion.browserStorage.get(incompleteCompletion.key), incompleteCompletionMarker);

const unpersisted = multipartHarness('signFailure');
const unpersistedError = await captureFailure(unpersisted.module.multipartEngineering.uploadWithMultipart(
  unpersisted.file, unpersisted.context, 'invalid multipart response', undefined, true,
));
assert.equal(unpersisted.module.describeUploadFileError(unpersistedError).recovery, 'none');
assert.deepEqual(unpersisted.calls, { start: 1, sign: 0, complete: 0, abort: 0, partPut: 0 });

const pickerSource = fs.readFileSync(pickerPath, 'utf8');
const pickerAst = ts.createSourceFile('picker.tsx', pickerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let uploadArrow: ts.ArrowFunction | undefined;
let directoryEffect: ts.ArrowFunction | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(pickerAst) === 'upload' && node.initializer && ts.isArrowFunction(node.initializer)) uploadArrow = node.initializer;
  if (ts.isCallExpression(node) && node.expression.getText(pickerAst) === 'useEffect' && node.arguments[0]?.getText(pickerAst).includes('setDirectoryError')) {
    const candidate = node.arguments[0];
    if (ts.isArrowFunction(candidate) && candidate.getText(pickerAst).includes('const token = ++sequence.current')) directoryEffect = candidate;
  }
  ts.forEachChild(node, visit);
}
visit(pickerAst);
assert.ok(uploadArrow && directoryEffect, 'Actual picker upload and directory effect must be extractable');
const pickerHelpers = evaluate(declarations(pickerSource, ['reconcileUploadFailures', 'removeUploadFailure', 'defaults', 'pickerFilterKey'])
  + '\nexport { defaults, pickerFilterKey };', {}, {}, 'picker-helpers.engineering.ts');

function pickerHarness(onUploadFile: (file: File) => Promise<string | { id?: string }>, sessionReady = true) {
  const state = { selected: [] as Array<{ identity: string }>, failed: [] as any[], error: '', directoryError: 'old directory error', notice: '', directoryNotice: '', busy: false, epoch: 0, label: '',
    navigation: null as any, query: 'old-filter', page: 3, loadedFilter: 'old-filter',
    prefs: { ...pickerHelpers.defaults, scope: 'shared', query: 'old-filter', filtersOpen: true, selectionOpen: true } };
  const browseRevision = { current: 0 }, sequence = { current: 0 }, readingMore = { current: false }, restoring = { current: false };
  const locked = { current: false }, session = { current: 1 }, active = { current: true };
  const apply = <T>(current: T, value: T | ((previous: T) => T)) => typeof value === 'function' ? (value as (previous: T) => T)(current) : value;
  const uploadCalls = new Map<string, number>();
  const module = evaluate(`export const upload = ${uploadArrow!.getText(pickerAst)};\nexport const effect = ${directoryEffect!.getText(pickerAst)};`, {
    locked, session, active, sessionReady, browseRevision, sequence, readingMore, restoring,
    defaults: pickerHelpers.defaults, pickerFilterKey: pickerHelpers.pickerFilterKey,
    types: ['image'], labels: { image: '图片' }, selected: [], target: 'workspace', typesKey: 'image', confirmLabel: '添加到参考区',
    uniqueUploadFiles: async (files: File[]) => ({ files, duplicates: 0 }), canSelect: () => '', existing: () => false,
    failedUploadIds: { current: new WeakMap<File, string>() }, crypto: { randomUUID: crypto.randomUUID },
    describeUploadFileError: unknown.module.describeUploadFileError,
    reconcileUploadFailures: pickerHelpers.reconcileUploadFailures,
    onUploadFile: async (file: File) => { uploadCalls.set(file.name, (uploadCalls.get(file.name) || 0) + 1); return onUploadFile(file); },
    fetch: async () => Response.json({ items: [{ key: 'asset:asset-ok', identity: 'asset:asset-ok', assetId: 'asset-ok', id: 'asset-ok', type: 'image', originalUrl: '/ok', thumbnailUrl: null, fileName: 'ok.png', width: 1, height: 1, duration: null, createdAt: new Date(0).toISOString(), source: 'uploaded' }] }),
    readJsonResponse: async (response: Response) => response.json(), uploadReceipts: { current: new Map() },
    setBusy: (value: boolean) => { state.busy = value; }, setError: (value: string) => { state.error = value; },
    setNotice: (value: string) => { state.notice = value; }, setProgress: () => {}, setUploadLabel: (value: string) => { state.label = value; },
    setSelected: (value: any) => { state.selected = apply(state.selected, value); }, setFailedUploads: (value: any) => { state.failed = apply(state.failed, value); },
    change: () => {}, setQuery: (value: string) => { state.query = value; }, setNavigation: (value: any) => { state.navigation = value; }, setEpoch: (value: any) => { state.epoch = apply(state.epoch, value); },
    open: true, ready: true, sessionOwner: 'picker-owner', prefsKey: 'picker-owner',
    setLoading: () => {}, setDirectoryError: (value: string) => { state.directoryError = value; }, setItems: () => {}, setLoadedFilter: (value: string) => { state.loadedFilter = value; }, setHasMore: () => {},
    prefs: state.prefs, readCursor: { current: null },
    fetchPage: async () => ({ items: [], albums: [], templates: [], total: 0, page: 1, hasMore: false, notice: '用途提示' }),
    setAlbums: () => {}, setTemplates: () => {}, setTotal: () => {}, setPage: (value: number) => { state.page = value; }, setDirectoryNotice: (value: string) => { state.directoryNotice = value; }, setPrefs: (value: any) => { state.prefs = apply(state.prefs, value); }, filterKey: 'picker-filter',
  }, {}, 'picker-callbacks.engineering.ts');
  return { module, state, locked, session, active, uploadCalls, browseRevision, sequence, readingMore, restoring };
}

const okFile = new File([Buffer.from('ok')], 'ok.png', { type: 'image/png' });
const pendingFile = new File([Buffer.from('pending')], 'pending.png', { type: 'image/png' });
const coldPicker = pickerHarness(async () => { throw Error('Unconfirmed session cannot upload'); }, false);
await coldPicker.module.upload([okFile]); coldPicker.module.effect();
assert.equal(coldPicker.uploadCalls.size, 0);
assert.equal(coldPicker.state.directoryError, 'old directory error');
const picker = pickerHarness(async (file) => {
  if (file === okFile) return { id: 'asset-ok' };
  throw new unknown.module.UploadFileError('原上传结果待确认', { code: 'RAW_UPLOAD_RESULT_UNKNOWN', causeCode: 'UPLOAD_PRIVATE_DIRECTORY_INVALID', stage: 'raw-writing', recovery: 'query' });
});
await picker.module.upload([okFile, pendingFile]);
assert.equal(picker.state.selected.length, 1);
assert.equal(picker.state.navigation.targetId, 'asset:asset-ok');
assert.equal(picker.state.navigation.revision, picker.browseRevision.current);
assert.equal(picker.state.navigation.filterKey, pickerHelpers.pickerFilterKey('image', picker.state.prefs));
assert.equal(picker.state.prefs.scope, 'mine'); assert.equal(picker.state.query, ''); assert.equal(picker.state.page, 1);
assert.equal(picker.state.prefs.filtersOpen, true); assert.equal(picker.state.prefs.selectionOpen, true);
assert.equal(picker.state.failed.length, 1);
assert.equal(picker.state.failed[0].message, '原上传结果待确认');
assert.equal(picker.state.failed[0].code, 'RAW_UPLOAD_RESULT_UNKNOWN');
assert.equal(picker.state.failed[0].causeCode, 'UPLOAD_PRIVATE_DIRECTORY_INVALID');
assert.equal(picker.state.failed[0].stage, 'raw-writing');
assert.equal(picker.state.failed[0].recovery, 'query');
assert.equal(picker.state.notice.includes('已上传或复用 1 个素材'), true);
picker.module.effect();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(picker.state.failed.length, 1);
assert.equal(picker.state.failed[0].message, '原上传结果待确认');
assert.equal(picker.state.directoryNotice, '用途提示');
await picker.module.upload([pendingFile]);
assert.equal(picker.uploadCalls.get('ok.png'), 1);
assert.equal(picker.uploadCalls.get('pending.png'), 2);

const resumeFile = new File([Buffer.from('resume')], 'resume.png', { type: 'image/png' });
const resumePicker = pickerHarness(async () => {
  throw new unknown.module.UploadFileError('原分块上传尚未完成', {
    code: 'MULTIPART_UPLOAD_RESUMABLE', stage: 'multipart-upload', recovery: 'resume',
  });
});
await resumePicker.module.upload([resumeFile]);
assert.equal(resumePicker.state.failed.length, 1);
assert.equal(resumePicker.state.failed[0].recovery, 'resume');

const markerBeforeRemove = unknown.browserStorage.get(unknownReceipt.key);
picker.state.failed = pickerHelpers.removeUploadFailure(picker.state.failed, picker.state.failed[0].id);
assert.equal(picker.state.failed.length, 0);
assert.equal(unknown.browserStorage.get(unknownReceipt.key), markerBeforeRemove);

const startedHolder: { resolve?: () => void } = {};
const releaseHolder: { resolve?: (value: string) => void } = {};
const started = new Promise<void>((resolve) => { startedHolder.resolve = resolve; });
const late = pickerHarness(() => {
  startedHolder.resolve?.();
  return new Promise<string>((resolve) => { releaseHolder.resolve = resolve; });
});
const lateFile = new File([Buffer.from('late')], 'late.png', { type: 'image/png' });
const lateUpload = late.module.upload([lateFile]);
await started;
late.session.current += 1;
late.locked.current = false;
late.state.selected = [];
late.state.failed = [];
late.state.notice = '';
assert.equal(typeof releaseHolder.resolve, 'function');
if (!releaseHolder.resolve) throw new Error('Late upload release callback was not installed');
releaseHolder.resolve('asset-late');
await lateUpload;
assert.equal(late.state.selected.length, 0);
assert.equal(late.state.failed.length, 0);
assert.equal(late.state.notice, ''); assert.equal(late.state.navigation, null);

// A valid upload may still finish after a deliberate filter/page interaction.
// Keep the uploaded selection but do not move the user's newer browse surface.
const browseStarted: { resolve?: () => void } = {}, browseRelease: { resolve?: (value: string) => void } = {};
const browsingStarted = new Promise<void>(resolve => { browseStarted.resolve = resolve; });
const browsing = pickerHarness(() => {
  browseStarted.resolve?.(); return new Promise<string>(resolve => { browseRelease.resolve = resolve; });
});
const browsingUpload = browsing.module.upload([new File([Buffer.from('browse')], 'browse.png', { type: 'image/png' })]);
await browsingStarted;
browsing.browseRevision.current++;
browsing.state.prefs = { ...browsing.state.prefs, scope: 'project', query: 'newer-user-filter' };
browsing.state.query = 'newer-user-filter'; browsing.state.page = 4;
const newerPreferences = JSON.stringify(browsing.state.prefs);
assert.equal(typeof browseRelease.resolve, 'function');
browseRelease.resolve!('asset-ok'); await browsingUpload;
assert.equal(browsing.state.selected.length, 1); assert.equal(browsing.uploadCalls.get('browse.png'), 1);
assert.equal(browsing.state.navigation, null); assert.equal(JSON.stringify(browsing.state.prefs), newerPreferences);
assert.equal(browsing.state.query, 'newer-user-filter'); assert.equal(browsing.state.page, 4);
assert.equal(browsing.state.busy, false); assert.equal(browsing.locked.current, false);

// Empty/nested connection errors keep a safe explanation and original-query
// action through the actual server diagnostic and client proxy boundary.
const diagnosticModule = evaluate(fs.readFileSync(path.join(repository, 'src/lib/assets/direct-upload-error.ts'), 'utf8'), {}, {}, 'direct-upload-error.engineering.ts');
const networkCause = Object.assign(new Error(''), { code: 'ENETUNREACH' });
const aggregate = Object.assign(new AggregateError([networkCause], ''), { code: 'ETIMEDOUT' });
const diagnostic = diagnosticModule.directUploadFailure(aggregate, 'proxy');
assert.ok(diagnostic.error.trim()); assert.equal(diagnostic.code, 'UPLOAD_RESULT_UNKNOWN');
assert.equal(diagnostic.causeCode, 'ETIMEDOUT'); assert.equal(diagnostic.recovery, 'query');
const proxyModule = evaluate(`${fs.readFileSync(clientPath, 'utf8')}\nexport const engineering = { uploadWithServerProxy };`, {}, {
  './json-response': { readJsonResponse: async (response: Response) => response.json() },
  './upload-session': { uploadSession: () => ({ ownerId: 'owner-proxy', epoch: 3 }) },
  './upload-progress': { calculateUploadTimeoutMs: () => 1000, notifyUploadProgress: () => {},
    requestJsonWithUploadProgress: async (options: { url: string; headers: Record<string, string> }) => {
      assert.equal(options.url, '/api/assets/upload-proxy');
      assert.equal(options.headers['X-Upload-Token'], 'original-proxy-token');
      assert.equal(options.headers['X-Upload-Owner-Id'], 'owner-proxy');
      return { ok: false, status: 503, data: diagnostic };
    } },
}, 'proxy-client.engineering.ts');
const proxyFailure = await captureFailure(proxyModule.engineering.uploadWithServerProxy({ uploadToken: 'original-proxy-token' },
  new File([Buffer.from('proxy')], 'video.mp4', { type: 'video/mp4' }),
  { ownerId: 'owner-proxy', requestId: 'original-proxy-request', hash: 'a'.repeat(64) }, 'invalid'));
assert.equal(proxyFailure instanceof proxyModule.UploadFileError, true);
assert.equal(proxyFailure.causeCode, 'ETIMEDOUT'); assert.equal(proxyFailure.stage, 'proxy'); assert.equal(proxyFailure.recovery, 'query');
assert.match(proxyFailure.message, /核对原上传/); assert.doesNotMatch(proxyFailure.message, /CORS|重新选择/);

const checks = [
  'empty AggregateError survives proxy mapping with original query recovery and finite cause code',
  'writing unknown exports query and performs one GET with zero POST',
  'notAccepted proof requires a second explicit action and rotates the original nonce',
  'invalid prepared proof remains query-only and preserves the original marker',
  'raw asset identity mismatch remains query-only and preserves the original marker',
  'durable completing multipart state repeats only completion with the original token',
  'multipart completion network JSON and missing-asset outcomes remain queryable',
  'uploading multipart state exposes resume while incomplete completing state and unpersisted start expose none',
  'directory reload preserves per-file code stage reason and recovery action',
  'picker preserves the multipart resume action for an explicit continue-upload control',
  'two-file partial success keeps the successful selection and does not retransmit it',
  'removing a failed row leaves the original upload marker untouched',
  'late upload completion cannot enter a changed account or target session',
  'verified uploaded asset receives a scoped focus intent while newer browsing is preserved',
];
process.stdout.write(`UPLOAD_CLIENT_ENGINEERING=${JSON.stringify({ completed: true, checks, forbiddenCalls: { network: 0, productionWrites: 0 } })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
