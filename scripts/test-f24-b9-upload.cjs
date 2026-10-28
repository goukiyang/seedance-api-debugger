const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const ts = require('typescript');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const owner = 'f24-synthetic-owner';
const base = 'https://objects.synthetic.invalid';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function load(file, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {
    URL, URLSearchParams, Request, Response, Buffer, process, console, AbortSignal, setTimeout, clearTimeout, ...globals,
  })(name => {
    if (name in dependencies) return dependencies[name];
    if (require('node:module').isBuiltin(name) || name === 'sharp') return require(name);
    throw new Error(`Unexpected fixture dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}
function verifier(state, prisma, siteUrl) {
  class HeadObjectCommand { constructor(input) { this.input = input; } }
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class S3Client {
    async send(command) {
      state.calls.push({ kind: command.constructor.name, key: command.input.Key });
      if (command instanceof HeadObjectCommand) {
        state.heads++;
        if (state.headError) throw state.headError;
        return { ContentLength: state.bytes.length, ETag: state.changeVersion && state.heads > 1 ? 'changed' : 'original' };
      }
      assert.ok(command instanceof GetObjectCommand);
      return { ContentLength: state.wrongLength ? state.bytes.length + 1 : state.bytes.length, ETag: 'original',
        Body: (async function* () { yield state.changedBody || state.bytes; })() };
    }
  }
  const keyFile = 'src/lib/assets/upload-object-key.ts';
  return load('src/lib/assets/verified-upload.ts', {
    '@aws-sdk/client-s3': { S3Client, HeadObjectCommand, GetObjectCommand },
    '@prisma/client': { Prisma: {} },
    '@/lib/prisma': { prisma: prisma || { user: { findUnique: async () => ({ id: owner, status: 'active', role: 'user', account_type: 'internal' }) } } },
    './site-url': siteUrl || { siteUploadPathFromUrl: () => null },
    '@/lib/image-studio/protected-assets': { canReadStudioAsset: async () => state.allowed },
    ...(fs.existsSync(path.join(root, keyFile)) ? { './upload-object-key': load(keyFile) } : {}),
  });
}

test('existing b9 upload verification accepts only same-owner verified legacy/current objects', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'f24-upload-synthetic-'));
  const previousCwd = process.cwd();
  const names = ['R2_PUBLIC_BASE_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  await fsp.mkdir(path.join(directory, 'storage'), { mode: 0o700 });
  await fsp.mkdir(path.join(directory, 'storage/verified-uploads'), { mode: 0o700 });
  process.chdir(directory);
  Object.assign(process.env, { R2_PUBLIC_BASE_URL: base, R2_ACCOUNT_ID: 'synthetic-only',
    R2_ACCESS_KEY_ID: 'synthetic-only', R2_SECRET_ACCESS_KEY: 'synthetic-only', R2_BUCKET: 'synthetic-only' });
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
  const make = (patch = {}) => ({ bytes, allowed: true, heads: 0, calls: [], ...patch });
  const asset = (url, patch = {}) => ({ id: 'synthetic-asset', owner_id: owner, status: 'active',
    hash: digest(bytes), mime_type: 'image/png', file_size: bytes.length, original_url: url, ...patch });
  const legacy = `${base}/seedance-uploads/abcdef01-1793000000000.png`;
  try {
    await t.test('historical object returns real decoded proof without publishing or changing the URL', async () => {
      const state = make(), api = verifier(state), row = asset(legacy);
      const proof = await api.verifyExistingUpload(row, owner);
      assert.ok(proof, 'DB-owned historical object must not be treated as unverifiable');
      try {
        assert.equal(proof.hash, row.hash); assert.equal(proof.bytes, row.file_size);
        assert.equal(proof.mimeType, 'image/png'); assert.equal(proof.width, 2); assert.equal(proof.height, 2);
        assert.equal(row.original_url, legacy);
        assert.deepEqual(state.calls.map(call => call.kind), ['HeadObjectCommand', 'GetObjectCommand', 'HeadObjectCommand']);
      } finally { await api.releaseVerifiedUpload(proof); }
    });
    await t.test('current owner-specific path retains its existing proof', async () => {
      const state = make(), api = verifier(state);
      const proof = await api.verifyExistingUpload(asset(`${base}/seedance-direct-uploads/${digest(owner).slice(0, 16)}/original.png`), owner);
      assert.ok(proof); await api.releaseVerifiedUpload(proof);
    });
    await t.test('wrong owner, inactive row, missing hash and source permission denial remain rejected before object reads', async () => {
      for (const patch of [{ owner_id: 'other-owner' }, { status: 'hidden' }, { hash: null }]) {
        const state = make();
        await assert.rejects(verifier(state).verifyExistingUpload(asset(legacy, patch), owner));
        assert.equal(state.calls.length, 0);
      }
      const state = make({ allowed: false });
      await assert.rejects(verifier(state).verifyExistingUpload(asset(legacy), owner), error => error.code === 'UPLOAD_ASSET_UNAVAILABLE');
      assert.equal(state.calls.length, 0);
    });
    await t.test('foreign, credentialed, query/fragment and normalized traversal URLs are never fetched', async () => {
      for (const url of [legacy.replace(base, 'https://outside.invalid'), legacy.replace('https://', 'https://u:p@'),
        legacy + '?token=synthetic', legacy + '#fragment', `${base}/seedance-uploads/../private.png`,
        `${base}/seedance-uploads/%2e%2e/private.png`, `${base}/seedance-uploads/a%2fb.png`,
        `${base}/seedance-direct-uploads/other-owner/original.png`]) {
        const state = make();
        assert.equal(await verifier(state).verifyExistingUpload(asset(url), owner), null, url);
        assert.equal(state.calls.length, 0);
      }
    });
    await t.test('GET length differs from HEAD is rejected before staging', async () => {
      const state = make({ wrongLength: true });
      await assert.rejects(verifier(state).verifyExistingUpload(asset(legacy), owner), error => error.code === 'UPLOAD_SOURCE_CHANGED');
    });
    await t.test('different bytes, MIME and changed post-read object version still fail', async () => {
      const changedBody = Buffer.from(bytes); changedBody[changedBody.length - 1] ^= 1;
      for (const [state, patch] of [[make({ changedBody }), {}], [make(), { mime_type: 'image/jpeg' }], [make({ changeVersion: true }), {}]]) {
        await assert.rejects(verifier(state).verifyExistingUpload(asset(legacy, patch), owner));
      }
      assert.deepEqual(await fsp.readdir(path.join(directory, 'storage/verified-uploads')), []);
    });
  } finally {
    process.chdir(previousCwd);
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('actual raw upload, registration, recovery and workspace transitions with private SQLite and real decoded files', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'upload-transitions-synthetic-'));
  const previousCwd = process.cwd();
  const names = ['R2_PUBLIC_BASE_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const databaseUrl = `file:${path.join(directory, 'synthetic.db')}`;
  let db;
  try {
    // Explicit local database only. No application env loader or shared Prisma singleton.
    require('node:child_process').execFileSync(process.execPath, [require.resolve('prisma/build/index.js'),
      'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], {
      cwd: directory, env: { ...process.env, DATABASE_URL: databaseUrl, CHECKPOINT_DISABLE: '1' }, stdio: 'pipe', timeout: 60000,
    });
    db = new (require('@prisma/client').PrismaClient)({ datasources: { db: { url: databaseUrl } } });
    process.chdir(directory);
    await fsp.mkdir(path.join(directory, 'storage/verified-uploads'), { recursive: true, mode: 0o700 });
    await fsp.chmod(path.join(directory, 'storage/verified-uploads'), 0o700);
    await fsp.mkdir(path.join(directory, 'public/uploads/assets'), { recursive: true });
    Object.assign(process.env, { R2_PUBLIC_BASE_URL: base, R2_ACCOUNT_ID: 'synthetic-only',
      R2_ACCESS_KEY_ID: 'synthetic-only', R2_SECRET_ACCESS_KEY: 'synthetic-only', R2_BUCKET: 'synthetic-only' });
    await db.user.create({ data: { id: owner, name: 'Synthetic', username: owner, email: `${owner}@synthetic.invalid`, password_hash: 'not-a-login', status: 'active' } });
    const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#123456' } }).png().toBuffer();
    const remote = { bytes, allowed: true, heads: 0, calls: [] };
    const siteUrl = load('src/lib/assets/site-url.ts');
    let refuseCas = false;
    const store = { user: db.user, asset: db.asset, platformSetting: {
      findUnique: args => db.platformSetting.findUnique(args), create: args => db.platformSetting.create(args),
      async updateMany(args) {
        if (refuseCas) return { count: 0 };
        return db.platformSetting.updateMany(args);
      },
    }, $transaction: run => db.$transaction(tx => run({ ...tx, platformSetting: {
      findUnique: args => tx.platformSetting.findUnique(args), create: args => tx.platformSetting.create(args),
      updateMany: args => refuseCas ? Promise.resolve({ count: 0 }) : tx.platformSetting.updateMany(args),
    } })) };
    const verified = verifier(remote, store, siteUrl);
    const similarity = { enqueueUploadSimilarity: async () => {}, uploadSimilarityStatus: async () => ({ state: 'disabled', coverage: 'new_uploads_only' }) };
    const storage = load('src/lib/assets/storage.ts', { '@/lib/prisma': { prisma: store }, '@/lib/assets/site-url': siteUrl,
      '@/lib/assets/video-thumbnail': { generateAssetVideoThumbnail: async () => { throw Error('No video in this fixture'); } },
      '@/lib/image-studio/protected-assets': { assertStudioCoverAssetNotReferenced: async () => {} },
      './verified-upload': verified, './upload-similarity': similarity });
    const publicStorage = { isPubliclyReachableUrl: url => /^https:\/\//.test(url), uploadPublicAsset: async () => { throw Error('Network forbidden'); } };
    const site = load('src/lib/assets/site-upload.ts', { '@/lib/prisma': { prisma: store }, '@/lib/assets/storage': storage,
      '@/lib/assets/public-storage': publicStorage, '@/lib/assets/site-url': siteUrl });
    const proofs = new Map();
    const raw = load('src/lib/assets/raw-upload-state.ts', { '@/lib/prisma': { prisma: store }, './verified-upload': verified,
      './site-upload': site, './public-storage': publicStorage, './upload-similarity': similarity,
      './raw-upload-recovery-proof': { readRawUploadRecoveryProof: async (key, state) => proofs.get(key) === digest(state) ? digest(state) : null } });
    const route = load('src/app/api/assets/upload/route.ts', { 'next/server': { NextResponse: { json: (value, options) => Response.json(value, options) } },
      '@/lib/auth/session': { getSession: () => db.user.findUnique({ where: { id: owner } }) }, '@/lib/prisma': { prisma: store },
      '@/lib/assets/verified-upload': verified, '@/lib/assets/raw-upload-state': raw, '@/lib/assets/site-upload': site,
      '@/lib/assets/direct-upload-error': load('src/lib/assets/direct-upload-error.ts'),
      '@/lib/assets/upload-log': { recordAssetUploadLog: async () => {} }, '@/lib/media/hd-derivatives': { requestHd: async () => {} } });
    const identity = (requestId, buffer = bytes) => ({ ownerId: owner, requestId, hash: digest(buffer), fileSize: buffer.length, mimeType: 'image/png' });
    const stateKey = id => `raw_upload_attempt_v2:${digest(id.ownerId)}:${digest(id.requestId)}`;
    const stateRow = id => db.platformSetting.findUnique({ where: { key: stateKey(id) } });
    const post = (id, nonce, buffer = bytes, patch = {}) => route.POST(new Request('https://synthetic.invalid/api/assets/upload', {
      method: 'POST', headers: { 'Content-Type': id.mimeType, 'X-File-Size': String(id.fileSize), 'X-File-Hash': id.hash,
        'X-Upload-Owner-Id': id.ownerId, 'X-Upload-Request-Id': id.requestId, 'X-Raw-Upload-Version': '2',
        'X-Raw-Upload-Nonce': nonce, 'X-File-Name': 'synthetic.png', ...patch }, body: buffer }));
    const makeWriting = async id => {
      const prepared = await raw.prepareRawUpload(id);
      await raw.transitionRawUpload(id, prepared.rawUpload.nonce, 'prepared', 'receiving');
      await raw.transitionRawUpload(id, prepared.rawUpload.nonce, 'receiving', 'writing');
      const row = await stateRow(id); proofs.set(row.key, digest(row.value_json));
      return prepared.rawUpload.nonce;
    };
    const oldAsset = await db.asset.create({ data: { id: 'synthetic-old-asset', owner_id: owner, type: 'image',
      original_url: `${base}/unrecognized-path/old.png`, file_name: 'old.png', mime_type: 'image/png', file_size: bytes.length, hash: digest(bytes), status: 'active' } });
    await t.test('known unsupported old source rejects before staging; same file retries original id and only current nonce', async () => {
      const id = identity('synthetic-preflight'), prepared = await raw.prepareRawUpload(id);
      const response = await post(id, prepared.rawUpload.nonce), result = await response.json();
      assert.equal(result.code, 'RAW_UPLOAD_NOT_ACCEPTED'); assert.equal(result.causeCode, 'UPLOAD_EXISTING_FILE_INVALID');
      assert.equal(result.errorStage, 'existing-asset-preflight'); assert.equal((await raw.readRawUploadState(id)).phase, 'notAccepted');
      assert.deepEqual(await fsp.readdir(path.join(directory, 'storage/verified-uploads')), []);
      assert.equal(await db.asset.count(), 1); assert.equal(await db.platformSetting.count({ where: { key: { startsWith: 'upload_receipt_v2:' } } }), 0);
      await db.asset.update({ where: { id: oldAsset.id }, data: { original_url: `${base}/seedance-uploads/abcdef01-1793000000000.png` } });
      const retry = await raw.prepareRawUpload(id, prepared.rawUpload.nonce);
      assert.equal(retry.rawUpload.requestId, id.requestId); assert.notEqual(retry.rawUpload.nonce, prepared.rawUpload.nonce);
      assert.equal((await post(id, prepared.rawUpload.nonce)).status, 409);
      const accepted = await post(id, retry.rawUpload.nonce), data = await accepted.json();
      assert.equal(accepted.status, 200); assert.equal(data.asset.id, oldAsset.id); assert.equal(data.asset.reused, true);
      assert.equal(data.asset.upload.requestId, id.requestId); assert.equal(await db.asset.count(), 1);
      assert.equal((await raw.readRawUploadState(id)).phase, 'completed');
      const beforeCalls = remote.calls.length;
      assert.equal((await post(id, prepared.rawUpload.nonce)).status, 200, 'Original receipt precedes stale nonce');
      assert.ok(remote.calls.slice(beforeCalls).every(call => ['HeadObjectCommand', 'GetObjectCommand'].includes(call.kind)));
    });
    await t.test('read-only preflight rejects identity and permission before GET/staging, but HEAD does not decode', async () => {
      const before = remote.calls.length;
      await assert.rejects(verified.preflightVerifiedOwnUpload(owner, digest(bytes), 'image/jpeg', bytes.length), error => error.code === 'UPLOAD_IDENTITY_MISMATCH');
      remote.allowed = false;
      await assert.rejects(verified.preflightVerifiedOwnUpload(owner, digest(bytes), 'image/png', bytes.length), error => error.code === 'UPLOAD_ASSET_UNAVAILABLE');
      remote.allowed = true;
      assert.equal(remote.calls.length, before);
      await verified.preflightVerifiedOwnUpload(owner, digest(bytes), 'image/png', bytes.length);
      assert.deepEqual(remote.calls.slice(before).map(call => call.kind), ['HeadObjectCommand']);
      assert.deepEqual(await fsp.readdir(path.join(directory, 'storage/verified-uploads')), []);
    });
    await t.test('HEAD timeout and SDK 404 keep exact safe causes and reject before any GET or staged file', async () => {
      for (const [suffix, error, cause] of [
        ['timeout', Object.assign(new Error('Synthetic timeout https://synthetic.invalid/?secret=x'), { name: 'TimeoutError' }), 'TimeoutError'],
        ['404', Object.assign(new Error('Synthetic missing object'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }), 'HTTP_404'],
      ]) {
        const id = identity(`synthetic-head-${suffix}`), prepared = await raw.prepareRawUpload(id), before = remote.calls.length;
        remote.headError = error;
        const response = await post(id, prepared.rawUpload.nonce), data = await response.json();
        delete remote.headError;
        assert.equal(response.status, 503); assert.equal(data.code, 'RAW_UPLOAD_NOT_ACCEPTED'); assert.equal(data.causeCode, cause);
        assert.equal((await raw.readRawUploadState(id)).phase, 'notAccepted');
        assert.deepEqual(remote.calls.slice(before).map(call => call.kind), ['HeadObjectCommand']);
        assert.ok(!JSON.stringify(data).includes('secret'));
        assert.deepEqual(await fsp.readdir(path.join(directory, 'storage/verified-uploads')), []);
      }
    });
    await t.test('actual staging/decode failure stays writing and cannot repost, even after staging cleanup', async () => {
      const invalid = Buffer.from('not-a-decodable-image'), id = identity('synthetic-invalid-content', invalid);
      const prepared = await raw.prepareRawUpload(id), response = await post(id, prepared.rawUpload.nonce, invalid), data = await response.json();
      assert.equal(data.code, 'UPLOAD_IMAGE_INVALID'); assert.notEqual(data.notAccepted, true);
      assert.equal(data.errorStage, 'writing'); assert.equal((await raw.readRawUploadState(id)).phase, 'writing');
      assert.equal((await post(id, prepared.rawUpload.nonce, invalid)).status, 409);
      assert.equal(await raw.rawUploadRecoveryToken(id), null);
      await assert.rejects(raw.recoverRetiredRawUpload(id, 'a'.repeat(64)));
      assert.deepEqual(await fsp.readdir(path.join(directory, 'storage/verified-uploads')), []);
    });
    await t.test('in-memory receiving failure is safely rejected; changed owner cannot claim or consume the nonce', async () => {
      const id = identity('synthetic-interrupted'), prepared = await raw.prepareRawUpload(id);
      const wrongOwner = await post(id, prepared.rawUpload.nonce, bytes, { 'X-Upload-Owner-Id': 'synthetic-other-owner' });
      assert.equal(wrongOwner.status, 409); assert.equal((await raw.readRawUploadState(id)).phase, 'prepared');
      const response = await post(id, prepared.rawUpload.nonce, bytes.subarray(0, bytes.length - 1)), data = await response.json();
      assert.equal(data.code, 'RAW_UPLOAD_NOT_ACCEPTED'); assert.equal(data.causeCode, 'UPLOAD_SIZE_MISMATCH');
      assert.equal((await raw.readRawUploadState(id)).phase, 'notAccepted');
      assert.deepEqual(await fsp.readdir(path.join(directory, 'storage/verified-uploads')), []);
    });
    await t.test('real new file publishes once; repeat requests reuse the verified Asset without overwriting bytes', async () => {
      const localBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#654321' } }).png().toBuffer();
      for (const requestId of ['synthetic-new-local', 'synthetic-new-local-repeat']) {
        const id = identity(requestId, localBytes), prepared = await raw.prepareRawUpload(id);
        const response = await post(id, prepared.rawUpload.nonce, localBytes), data = await response.json();
        assert.equal(response.status, 200); assert.equal(data.asset.hash, digest(localBytes));
        assert.equal(data.asset.reused, requestId.endsWith('repeat'));
        assert.equal(data.asset.upload.requestId, requestId);
      }
      const published = path.join(directory, 'public/uploads/assets', `${digest(localBytes)}.png`);
      assert.equal(digest(await fsp.readFile(published)), digest(localBytes));
      assert.equal(await db.asset.count({ where: { owner_id: owner, hash: digest(localBytes) } }), 1);
      assert.deepEqual(await fsp.readdir(path.join(directory, 'storage/verified-uploads')), []);
      await db.asset.deleteMany({ where: { hash: digest(localBytes) } });
    });
    await t.test('same-owner recovery verifies real bytes and writes the original receipt only behind exact proof', async () => {
      const id = identity('synthetic-retired'), nonce = await makeWriting(id), before = (await stateRow(id)).value_json;
      const token = await raw.rawUploadRecoveryToken(id);
      await assert.rejects(raw.recoverRetiredRawUpload(id, '0'.repeat(64)));
      const recovered = await raw.recoverRetiredRawUpload(id, token);
      assert.equal(recovered.asset.id, oldAsset.id); assert.equal(recovered.asset.upload.requestId, id.requestId);
      assert.equal(recovered.asset.upload.verified, true); assert.equal(await db.asset.count(), 1);
      assert.equal((await stateRow(id)).value_json, before, 'Registration never resets original marker or nonce');
      remote.allowed = false;
      await assert.rejects(raw.recoverRetiredRawUpload(id, token), error => error.code === 'UPLOAD_ASSET_UNAVAILABLE');
      remote.allowed = true;
      const response = await post(id, nonce); assert.equal(response.status, 200, 'Fresh receipt precedes writing marker');
    });
    await t.test('recovery permission, hash, inactive owner and stale proof failures cannot register or unlock', async () => {
      for (const failure of ['permission', 'hash', 'owner', 'state']) {
        const id = identity(`synthetic-recovery-${failure}`); await makeWriting(id);
        const token = await raw.rawUploadRecoveryToken(id), before = (await stateRow(id)).value_json;
        if (failure === 'permission') remote.allowed = false;
        if (failure === 'hash') remote.changedBody = Buffer.from(bytes).fill(0, 0, 8);
        if (failure === 'owner') await db.user.update({ where: { id: owner }, data: { status: 'disabled' } });
        if (failure === 'state') await db.platformSetting.update({ where: { key: stateKey(id) }, data: { value_json: before + ' ' } });
        await assert.rejects(raw.recoverRetiredRawUpload(id, token));
        remote.allowed = true; delete remote.changedBody;
        await db.user.update({ where: { id: owner }, data: { status: 'active' } });
        assert.equal((await raw.readRawUploadState(id)).phase, 'writing');
        assert.equal(await db.platformSetting.count({ where: { key: `upload_receipt_v2:${digest(owner)}:${digest(id.requestId)}` } }), 0);
      }
    });
    await t.test('retired no-asset CAS failure and foreign/inactive assets never release original writing', async () => {
      const id = identity('synthetic-retired-cas', Buffer.from('synthetic-no-original')); await makeWriting(id);
      const token = await raw.rawUploadRecoveryToken(id), before = (await stateRow(id)).value_json;
      refuseCas = true; await assert.rejects(raw.recoverRetiredRawUpload(id, token)); refuseCas = false;
      assert.equal((await stateRow(id)).value_json, before);
      await assert.rejects(raw.recoverRetiredRawUpload({ ...id, ownerId: 'synthetic-other-owner' }, token));
      await db.asset.update({ where: { id: oldAsset.id }, data: { status: 'deleted' } });
      const inactive = identity('synthetic-retired-deleted'); await makeWriting(inactive);
      await assert.rejects(raw.recoverRetiredRawUpload(inactive, await raw.rawUploadRecoveryToken(inactive)), error => error.code === 'UPLOAD_EXISTING_INACTIVE');
      await db.asset.update({ where: { id: oldAsset.id }, data: { status: 'active' } });
      assert.equal((await raw.readRawUploadState(inactive)).phase, 'writing');
    });
    await t.test('real WorkspaceAsset delete then verified same-byte re-add preserves Asset and avoids duplicates', async () => {
      const workspace = load('src/lib/assets/workspace.ts', { '@/lib/prisma': { prisma: db }, uuid: { v4: crypto.randomUUID }, '@/lib/assets/site-url': siteUrl });
      const target = await db.workspace.create({ data: { id: 'synthetic-workspace', owner_id: owner, name: 'Synthetic' } });
      const first = await workspace.addAssetToWorkspace(target.id, oldAsset.id, 'reference_image', owner);
      await workspace.removeAssetFromWorkspace(target.id, oldAsset.id);
      assert.equal(await db.workspaceAsset.count(), 0); assert.equal((await db.asset.findUnique({ where: { id: oldAsset.id } })).status, 'active');
      const id = identity('synthetic-re-add'), prepared = await raw.prepareRawUpload(id), response = await post(id, prepared.rawUpload.nonce), data = await response.json();
      assert.equal(response.status, 200); assert.equal(data.asset.id, oldAsset.id); assert.equal(data.asset.reused, true);
      const second = await workspace.addAssetToWorkspace(target.id, data.asset.id, 'reference_image', owner);
      assert.notEqual(second, first);
      assert.equal(await workspace.addAssetToWorkspace(target.id, data.asset.id, 'reference_image', owner), second);
      assert.equal(await db.workspaceAsset.count(), 1); assert.equal(await db.asset.count(), 1);
      await assert.rejects(workspace.addAssetToWorkspace(target.id, data.asset.id, 'reference_image', 'synthetic-other-owner'));
      await db.asset.update({ where: { id: oldAsset.id }, data: { status: 'deleted' } });
      await assert.rejects(workspace.addAssetToWorkspace(target.id, data.asset.id, 'reference_image', owner));
      await db.asset.update({ where: { id: oldAsset.id }, data: { status: 'active' } });
    });
  } finally {
    await db?.$disconnect(); process.chdir(previousCwd);
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
