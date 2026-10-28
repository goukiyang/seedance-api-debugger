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
function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {
    URL, Buffer, process, console, AbortSignal, setTimeout, clearTimeout,
  })(name => {
    if (name in dependencies) return dependencies[name];
    if (name.startsWith('node:') || name === 'sharp') return require(name);
    throw new Error(`Unexpected fixture dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}
function verifier(state) {
  class HeadObjectCommand { constructor(input) { this.input = input; } }
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class S3Client {
    async send(command) {
      state.calls.push({ kind: command.constructor.name, key: command.input.Key });
      if (command instanceof HeadObjectCommand) {
        state.heads++;
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
    '@/lib/prisma': { prisma: { user: { findUnique: async () => ({ id: owner, status: 'active', role: 'user', account_type: 'internal' }) } } },
    './site-url': { siteUploadPathFromUrl: () => null },
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
