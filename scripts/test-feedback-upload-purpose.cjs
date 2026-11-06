// Isolated engineering checks: private SQLite only; no real feedback, media or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { PrismaClient, Prisma } = require('@prisma/client');
const root = path.resolve(__dirname, '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
function load(file, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(source(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    if (name in dependencies) return dependencies[name];
    throw Error('Unexpected dependency ' + name);
  }, Buffer, URL, console }, { filename: file });
  return module.exports;
}
// Evaluate the actual changed functions, substituting only unchanged file proof /
// HD integration. All registration and rollback use the real Prisma/SQLite transaction.
function functions(file, names, bindings) {
  const text = source(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const selected = ast.statements.filter(node => node.name && names.includes(node.name.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.includes(d.name.getText(ast))));
  const code = ts.transpileModule(selected.map(n => n.getText(ast).replace(/^export /, '')).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(bindings), code + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
}
async function browserUploadIdentity() {
  const storage = new Map(), observed = [], owner = 'browser-fixture', hash = sha('browser-fixture');
  const sessionStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const browser = functions('src/lib/http/file-upload.ts', ['rawReceiptKey', 'rawIdentityMatches', 'readRawMarker', 'uploadFileToHistory'], {
    crypto, sessionStorage, fileRequests: new WeakMap(), rawReceipts: new WeakMap(), inFlightUploads: new Map(),
    uploadSession: () => ({ ownerId: owner, epoch: 7 }), sha256File: async () => hash, notifyUploadProgress: () => {},
    uploadFileToHistoryInternal: async (_file, options) => { observed.push(options); return { id: 'fixture-asset' }; },
  });
  const file = () => ({ size: 8, type: 'image/png' });
  await browser.uploadFileToHistory(file(), { purpose: 'feedback' });
  assert.equal(observed.pop().purpose, 'feedback');
  const originalId = crypto.randomUUID();
  storage.set(`sd2:raw-upload:v1:${owner}:${hash}:8:image/png`, JSON.stringify({ version: 2, ownerId: owner, hash,
    requestId: originalId, fileSize: 8, mimeType: 'image/png', phase: 'sending', nonce: 'a'.repeat(48) }));
  await browser.uploadFileToHistory(file(), { purpose: 'feedback' });
  const legacy = observed.pop(); assert.equal(legacy.purpose, undefined); assert.equal(legacy.requestId, originalId);
  storage.clear();
  storage.set(`sd2:direct-upload:v1:${owner}:${hash}:8:image/png`, JSON.stringify({ uploadToken: 'synthetic-ticket' }));
  storage.set(`sd2:upload-request:v1:${owner}:7:${hash}:8:image/png`, originalId);
  await browser.uploadFileToHistory(file(), { purpose: 'feedback' });
  const direct = observed.pop(); assert.equal(direct.purpose, undefined); assert.equal(direct.requestId, originalId);
}
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-feedback-purpose-'));
  const url = 'file:' + path.join(directory, 'fixture.sqlite');
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { DATABASE_URL: url, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' });
  execFileSync(process.execPath, [path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js'),
    'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], { env, encoding: 'utf8', timeout: 300000 });
  const db = new PrismaClient({ datasources: { db: { url } } });
  globalThis.fetch = () => { throw Error('External network is forbidden'); };
  const checks = [];
  const purpose = load('src/lib/assets/upload-purpose.ts', { '@prisma/client': { Prisma } });
  const owner = 'feedback-purpose-fixture-owner';
  const proofFor = asset => ({ hash: asset.hash, bytes: asset.file_size, mimeType: asset.mime_type,
    type: 'image', file: '/synthetic-only', version: 'fixture-proof', sourceVersion: 'fixture-proof', width: 1, height: 1 });
  const register = functions('src/lib/assets/verified-upload.ts', ['VerifiedUploadError', 'receiptKey', 'readVerifiedUploadReceipt', 'registerVerifiedUpload'], {
    prisma: db, uploadDigest: sha, randomUUID: crypto.randomUUID, path, isFeedbackOnlyAsset: purpose.isFeedbackOnlyAsset,
    uploadIdentity: async () => {}, verifyExistingUpload: async asset => proofFor(asset), releaseVerifiedUpload: async () => {},
    canReadStudioAsset: async (user, asset) => user.id === asset.owner_id, registerCommittedAssetHd: async () => {},
    findVerifiedOwnUpload: async (ownerId, hash) => { const asset = await db.asset.findUnique({ where: { owner_id_hash: { owner_id: ownerId, hash } } }); return asset && { asset, proof: proofFor(asset) }; },
  });
  const raw = load('src/lib/assets/raw-upload-state.ts', {
    './upload-purpose': purpose,
    'node:crypto': crypto, '@/lib/prisma': { prisma: db }, './verified-upload': {
      ...register, uploadDigest: sha, uploadRequestId: value => value, releaseVerifiedUpload: async () => {},
    }, './site-upload': { validateSiteUploadMetadata: () => null, sameOriginPublicUrlForLocalUpload: u => u, isLocalPublicUploadUrl: () => true },
    './public-storage': { isPubliclyReachableUrl: () => false }, './upload-similarity': { uploadSimilarityStatus: async () => ({ state: 'disabled' }) },
    './raw-upload-recovery-proof': { readRawUploadRecoveryProof: async () => null },
  });
  const input = (key, hash, feedback = false) => ({ ownerId: owner, proof: { hash, bytes: 8, mimeType: 'image/png', type: 'image',
    width: 1, height: 1, version: 'fixture' }, fileName: feedback ? '反馈截图.png' : 'normal.png',
    originalUrl: '/uploads/assets/' + hash + '.png', thumbnailUrl: null, requestId: key, ...(feedback ? { purpose: 'feedback' } : {}) });
  try {
    await db.user.create({ data: { id: owner, name: 'Synthetic fixture', username: owner, email: owner + '@invalid.test', password_hash: 'synthetic-not-a-credential', status: 'active' } });
    const identity = raw.rawUploadIdentity(owner, { requestId: 'feedback-original', hash: sha('feedback'), fileSize: 8, mimeType: 'image/png', purpose: 'feedback' });
    const prepared = await raw.prepareRawUpload(identity);
    assert.equal(prepared.rawUpload.purpose, 'feedback');
    await assert.rejects(raw.readRawUploadState({ ...identity, purpose: undefined }), /上传编号/);
    assert.throws(() => raw.rawUploadIdentity(owner, { ...identity, purpose: 'arbitrary' }), /用途/);
    await raw.transitionRawUpload(identity, prepared.rawUpload.nonce, 'prepared', 'receiving');
    await assert.rejects(raw.prepareRawUpload(identity), /尚未确认/);
    await raw.transitionRawUpload(identity, prepared.rawUpload.nonce, 'receiving', 'writing');
    const saved = await register.registerVerifiedUpload(input(identity.requestId, identity.hash, true));
    assert.equal(saved.asset.status, 'active'); assert.equal(JSON.parse(saved.asset.metadata_json).feedbackOnly, true);
    await raw.transitionRawUpload(identity, prepared.rawUpload.nonce, 'writing', 'completed');
    const recovered = await raw.readRawUploadResult(identity);
    assert.equal(recovered.id, saved.asset.id); assert.equal(recovered.upload.purpose, 'feedback');
    await assert.rejects(raw.readRawUploadResult({ ...identity, purpose: undefined }), /上传编号/);
    assert.equal(await db.asset.count(), 1);
    checks.push('用途冻结、nonce在途不重传、完成后原号恢复且只有一份Asset');
    purpose.FEEDBACK_UPLOADS_ENABLED = false;
    assert.equal((await raw.prepareRawUpload(identity)).asset.id, saved.asset.id);
    await assert.rejects(raw.prepareRawUpload({ ...identity, requestId: 'guard-new-feedback' }), /暂不可用/);
    purpose.FEEDBACK_UPLOADS_ENABLED = true;
    checks.push('相容guard关闭新反馈上传，保留已受理原号读取/回放');

    assert.equal(await db.asset.count({ where: purpose.materialAssetWhere([]) }), 0);
    const imported = await register.registerVerifiedUpload(input('explicit-material-import', identity.hash));
    assert.equal(imported.asset.id, saved.asset.id); assert.equal(imported.reused, true);
    assert.equal(JSON.parse(imported.asset.metadata_json).feedbackOnly, undefined);
    assert.equal(JSON.parse(imported.asset.metadata_json).uploadIntegrity.hash, identity.hash);
    assert.equal(await db.asset.count({ where: purpose.materialAssetWhere([]) }), 1);
    await register.registerVerifiedUpload(input('feedback-reusing-material', identity.hash, true));
    assert.equal(await db.asset.count({ where: purpose.materialAssetWhere([]) }), 1);
    checks.push('反馈仅作附件，显式导入同字节复用后可见，正常素材用于反馈不消失');

    const concurrentHash = sha('concurrent');
    await Promise.all([register.registerVerifiedUpload(input('concurrent-feedback', concurrentHash, true)), register.registerVerifiedUpload(input('concurrent-material', concurrentHash))]);
    const concurrent = await db.asset.findUnique({ where: { owner_id_hash: { owner_id: owner, hash: concurrentHash } } });
    assert.equal(purpose.isFeedbackOnlyAsset(concurrent.metadata_json), false);
    const before = concurrent.metadata_json;
    await assert.rejects(register.registerVerifiedUpload({ ...input('feedback-original', concurrentHash), purpose: undefined }), /上传编号/);
    assert.equal((await db.asset.findUnique({ where: { id: concurrent.id } })).metadata_json, before);
    checks.push('并行反馈/普通导入共用原件，原号冲突事务回滚');

    const legacy = await db.asset.create({ data: { owner_id: owner, type: 'image', file_name: '反馈截图.png', mime_type: 'image/png', file_size: 8,
      original_url: '/uploads/legacy.png', hash: sha('legacy') } });
    await db.feedback.create({ data: { user_id: owner, content: 'synthetic', pathname: '/plugin/chatgpt', image_urls_json: JSON.stringify([legacy.original_url]) } });
    assert.deepEqual(Array.from(await purpose.legacyFeedbackAssetIds(db, owner)), [legacy.id]);
    const legacyIds = await purpose.legacyFeedbackAssetIds(db, owner);
    const viaPrisma = await db.asset.findMany({ where: purpose.materialAssetWhere(legacyIds), select: { id: true }, orderBy: { id: 'asc' } });
    const viaSql = await db.$queryRaw(Prisma.sql`SELECT a.id FROM Asset a WHERE ${purpose.materialAssetSql(Prisma.sql`a.metadata_json`, Prisma.sql`a.id`, legacyIds)} ORDER BY a.id`);
    assert.deepEqual(viaSql.map(a => a.id), viaPrisma.map(a => a.id));
    assert.equal(await db.asset.count(), 3); assert.equal(viaSql.length, 2);
    const collection = await db.assetCollection.create({ data: { owner_id: owner, name: 'synthetic-normal-materials' } });
    await db.assetCollectionItem.create({ data: { collection_id: collection.id, asset_id: legacy.id } });
    assert.equal((await purpose.legacyFeedbackAssetIds(db, owner)).length, 0);
    assert.equal((await db.asset.findUnique({ where: { id: legacy.id } })).status, 'active');
    checks.push('历史精确反馈关联过滤，真实SQLite SQL/Prisma列表与数量一致，共用素材/原图保留');
    await browserUploadIdentity();
    checks.push('网站新用途独立身份，升级前raw/direct未知请求沿原号原合同继续核对');
    for (const check of checks) console.log('ok', check);
    console.log('private SQLite fixture', directory);
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
