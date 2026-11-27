const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const Module = require('node:module');

const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'sd2-customer-api-'));
const policyFile = path.join(fixture, 'policy.json');
const write = (file, value) => fs.writeFileSync(file, Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: 'file:' + path.join(fixture, 'fixture.db'),
  SITE_PUBLIC_BASE_URL: 'https://site.fixture.invalid', SESSION_SECRET: randomBytes(48).toString('hex'),
  VOLCENGINE_IP_API_KEY: 'synthetic-upstream-key', VOLCENGINE_IP_BASE_URL: 'https://ark.fixture.invalid/api/v3',
  VOLCENGINE_IP_MODEL: 'doubao-seedance-2-5-260628', PRIVATE_PROMPTS_POLICY_FILE: policyFile,
  PRIVATE_PROMPTS_FIXTURE_ROOT: fixture, PRIVATE_PROMPTS_READ_ONLY: '0',
  PRIVATE_PROMPTS_MIN_STATE: 'compatible-read', PRIVATE_PROMPTS_CONSUMER_ID: 'fixture',
  PRIVATE_PROMPTS_RUNTIME_REVISION: 'a'.repeat(40),
});
const policy = { schema: 'private-prompt-policy.v1', revision: 'fixture-policy', state: 'compatible-read', minimumReader: 1,
  identities: [], origins: [], authorKinds: [], destinations: [], consumers: ['fixture'],
  keys: Object.fromEntries(['body', 'index', 'backup'].map(domain => {
    const file = path.join(fixture, domain + '.key');
    write(file, randomBytes(32));
    return [domain, { active: domain, files: { [domain]: file } }];
  })) };
write(policyFile, policy);
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'server-only') return {};
  const loaded = load.call(this, id, ...args);
  if (id !== '@/lib/customer-api/auth') return loaded;
  return { ...loaded, apiError(error, ...rest) {
    if (!(error instanceof loaded.CustomerApiError)) console.error('Isolated API handler error:', error);
    return loaded.apiError(error, ...rest);
  } };
};

let prisma;
let phase = 'isolated database and media';
let creates = 0;
let loseSubmissionResponse = false;
let acceptedInput;
let storageFixture;
async function main() {
  const baseline = process.env.CUSTOMER_API_BASELINE_SCHEMA;
  const sqlite = path.join(fixture, 'fixture.db');
  const schemaSql = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff',
    '--from-empty', '--to-schema-datamodel', baseline || path.join(root, 'prisma/schema.prisma'), '--script'], { cwd: fixture });
  const migration = baseline ? fs.readFileSync(path.join(root, 'prisma/migrations/20261127200000_customer_api/migration.sql')) : Buffer.alloc(0);
  execFileSync('python3', ['-c', 'import sqlite3,sys; sqlite3.connect(sys.argv[1]).executescript(sys.stdin.read())', sqlite],
    { input: Buffer.concat([schemaSql, migration]) });
  const mp4Path = path.join(fixture, 'original.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=1', '-pix_fmt', 'yuv420p', mp4Path]);
  const mp4 = fs.readFileSync(mp4Path);
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'media.fixture.invalid') {
      return new Response(mp4, { headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) } });
    }
    assert.equal(url.hostname, 'ark.fixture.invalid', 'External transport is forbidden');
    if (init.method === 'POST') {
      creates++;
      acceptedInput = JSON.parse(init.body);
      if (loseSubmissionResponse) throw new Error('fixture lost the response after acceptance');
      return Response.json({ id: 'fixture-provider-' + creates });
    }
    return Response.json({ id: url.pathname.split('/').pop(), client_request_id: acceptedInput.client_request_id,
      status: 'succeeded', content: { video_url: 'https://media.fixture.invalid/original.mp4' } });
  };

  prisma = require('../src/lib/prisma').prisma;
  const { API_SCOPES } = require('../src/lib/customer-api/auth');
  const { apiAdminSnapshot, mutateApiAdmin } = require('../src/lib/customer-api/admin');
  const { NextRequest } = require('next/server');
  const api = require('../src/app/api/v1/[...path]/route');
  const callback = require('../src/app/api/internal/customer-video/[id]/route');
  const providerMedia = require('../src/app/api/internal/customer-media/[id]/route');
  const { finalizeVideoTaskStatus } = require('../src/lib/video/task-finalizer');
  const runtime = path.join(fixture, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  for (const entry of ['node_modules', 'src', 'tsconfig.json']) fs.symlinkSync(path.join(root, entry), path.join(runtime, entry));
  fs.mkdirSync(path.join(runtime, 'scripts'), { mode: 0o700 });
  fs.symlinkSync(path.join(root, 'scripts/save-video-media.ts'), path.join(runtime, 'scripts/save-video-media.ts'));
  fs.writeFileSync(path.join(runtime, 'scripts/server-runtime.cjs'), [
    'require(' + JSON.stringify(path.join(root, 'scripts/server-runtime.cjs')) + ');',
    'const mp4 = require("node:fs").readFileSync(' + JSON.stringify(mp4Path) + ');',
    'global.fetch = async url => {',
    '  if (String(url) !== "https://media.fixture.invalid/original.mp4") throw new Error("Unplanned fixture transport");',
    '  return new Response(mp4, { headers: { "content-type": "video/mp4", "content-length": String(mp4.length) } });',
    '};',
  ].join('\n'), { mode: 0o600 });
  const storageRoot = process.env.CUSTOMER_API_TEST_STORAGE_ROOT;
  if (storageRoot) {
    const root = fs.realpathSync(storageRoot);
    assert(root.startsWith('/data/video-api-debugger/'), 'Use an isolated Linux data mount for the test');
    storageFixture = fs.mkdtempSync(path.join(root, 'customer-api-storage-'));
    fs.mkdirSync(path.join(storageFixture, 'verified-uploads'), { mode: 0o700 });
    fs.symlinkSync(storageFixture, path.join(runtime, 'storage'));
  } else fs.mkdirSync(path.join(runtime, 'storage'), { mode: 0o700 });
  process.chdir(runtime);

  async function provision(name, balance) {
    const user = await prisma.user.create({ data: { name, username: name, email: name + '@fixture.invalid',
      password_hash: 'synthetic', role: 'user', account_type: 'external', status: 'active', feature_profile_id: 'external_limited' } });
    const project = await prisma.project.create({ data: { name, type: 'personal', visibility: 'private',
      owner_user_id: user.id, created_by: user.id } });
    const card = await prisma.videoCard.create({ data: { project_id: project.id, title: name, owner_user_id: user.id, created_by: user.id } });
    await prisma.creditAccount.create({ data: { user_id: user.id, balance } });
    const customer = await prisma.apiCustomer.create({ data: { name, user_id: user.id, project_id: project.id,
      video_card_id: card.id, timezone: 'Asia/Shanghai', create_enabled: true, license_confirmed: true,
      models_json: '["seedance-2.5-ip"]', points_per_cny: 1, max_task_points: 50, daily_points: 50, monthly_points: 50,
      concurrency_limit: 5, storage_limit_bytes: 20_000_000n, upload_limit_bytes: 5_000_000n, retention_policy: 'fixture' } });
    await prisma.apiRate.create({ data: { customer_id: customer.id, model: 'seedance-2.5-ip',
      resolution: '720p', cny_per_second: 0.2, enabled: true } });
    return { user, customer };
  }
  const admin = await prisma.user.create({ data: { name: 'Fixture administrator', username: 'fixture-admin',
    email: 'admin@fixture.invalid', password_hash: 'synthetic', role: 'admin', account_type: 'internal', status: 'active' } });
  async function issue(customer, agent_id) {
    const key = await mutateApiAdmin(admin.id, { action: 'issue_key', operation_id: 'fixture-key-' + agent_id,
      customer_id: customer.id, revision: customer.revision, name: agent_id, agent_id,
      expires_at: new Date(Date.now() + 600_000).toISOString(), scopes: API_SCOPES,
      models: ['seedance-2.5-ip'], requests_per_minute: 100 });
    return { token: key.token, id: key.key_id };
  }
  async function call(method, route, key, body, id, additionalHeaders = {}) {
    const headers = { authorization: 'Bearer ' + key.token, ...additionalHeaders };
    if (body && !Buffer.isBuffer(body)) headers['content-type'] = 'application/json';
    if (id) Object.assign(headers, { 'idempotency-key': id, 'x-paid-generation-intent': 'user_authorized_real_provider',
      'x-paid-generation-reason': 'customer_authorized_video_generation' });
    const request = new NextRequest('https://site.fixture.invalid/api/v1/' + route,
      { method, headers, body: Buffer.isBuffer(body) ? body : body && JSON.stringify(body) });
    return api[method](request, { params: { path: route.split('?')[0].split('/') } });
  }
  const read = async response => ({ code: response.status, body: await response.json() });
  await prisma.apiConfiguration.create({ data: { id: 'global', enabled: true, license_confirmed: true,
    concurrency_limit: 8, storage_limit_bytes: 40_000_000n, max_output_bytes: 2_000_000n } });
  const team = await provision('team-fixture', 1);
  const outside = await provision('outside-fixture', 1);
  const first = await issue(team.customer, 'first-agent');
  await assert.rejects(() => issue(team.customer, 'duplicate-binding'), { code: 'KEY_ALREADY_BOUND', status: 409 });
  assert.equal((await apiAdminSnapshot(team.customer.id)).customer.has_bound_key, true);
  const stranger = await issue(outside.customer, 'stranger');
  phase = 'private input upload';
  const image = await require('sharp')({ create: {
    width: 640, height: 640, channels: 3, background: '#252525',
  } }).png().toBuffer();
  const imageHash = createHash('sha256').update(image).digest('hex');
  const uploadInput = { request_id: 'fixture-upload', sha256: imageHash, size_bytes: image.length,
    mime_type: 'image/png', file_name: 'reference.png' };
  const preparedUpload = await read(await call('POST', 'assets/uploads', first, uploadInput));
  assert.equal(preparedUpload.code, 201, JSON.stringify(preparedUpload));
  assert.equal(preparedUpload.body.status, 'prepared');
  const uploadPath = 'assets/uploads/' + preparedUpload.body.id;
  assert.equal((await call('GET', uploadPath, stranger)).status, 404);
  const transfer = await read(await call('PUT', uploadPath + '/transfer', first, image, null, {
    'content-type': 'image/png', 'content-length': String(image.length), 'upload-nonce': preparedUpload.body.transfer_nonce,
  }));
  assert.equal(transfer.code, 200, JSON.stringify(transfer));
  assert.equal(transfer.body.status, 'completed');
  assert.equal(transfer.body.asset.sha256, imageHash);
  const completedUpload = await read(await call('POST', uploadPath + '/complete', first));
  assert.equal(completedUpload.body.asset.id, transfer.body.asset.id);
  assert.equal((await call('POST', uploadPath + '/release', first)).status, 409);
  const abandoned = await read(await call('POST', 'assets/uploads', first, { ...uploadInput, request_id: 'abandoned-upload' }));
  assert.equal(abandoned.code, 201, JSON.stringify(abandoned));
  const abandonedPath = 'assets/uploads/' + abandoned.body.id;
  const released = await read(await call('POST', abandonedPath + '/release', first));
  assert.equal(released.code, 200, JSON.stringify(released));
  assert.equal(released.body.status, 'released');
  assert.equal((await call('POST', abandonedPath + '/recover', first)).status, 200);
  assert.equal((await call('PUT', abandonedPath + '/transfer', first, image, null, {
    'content-type': 'image/png', 'upload-nonce': abandoned.body.transfer_nonce,
  })).status, 409);
  const assetId = transfer.body.asset.id;
  const input = { model: 'seedance-2.5-ip', duration: 5, resolution: '720p', prompt: 'synthetic camera movement',
    image_assets: [assetId] };
  async function quote(key) {
    const response = await read(await call('POST', 'video/quotes', key, { input, max_cost_points: 1 }));
    assert.equal(response.code, 200, JSON.stringify(response));
    return { quote_id: response.body.id, input: response.body.input };
  }
  phase = 'quote and single-key admission';
  const models = await read(await call('GET', 'models', first));
  assert.deepEqual(models.body.models[0].resolutions, ['720p']);
  assert.equal((await call('POST', 'video/quotes', stranger, { input, max_cost_points: 1 })).status, 404);
  const winner = { key: first, id: 'first-attempt', body: await quote(first) };
  const other = { key: first, id: 'second-attempt', body: await quote(first) };
  const submission = await read(await call('POST', 'video/tasks', winner.key, winner.body, winner.id));
  assert.equal(submission.code, 202, JSON.stringify(submission));
  const accepted = submission.body;
  assert.equal(creates, 1);
  assert.equal(await prisma.creditLedger.count({ where: { type: 'task_freeze' } }), 1);
  const receipt = await prisma.apiRequest.findUnique({ where: { id: accepted.id } });
  assert.equal(receipt.key_id, winner.key.id);
  assert.equal((await call('GET', 'video/tasks/' + accepted.id, stranger)).status, 404);
  const signed = new URL(acceptedInput.content.find(entry => entry.type === 'image_url').image_url.url);
  assert.equal(signed.pathname, '/api/internal/customer-media/' + assetId);
  const signedImage = await providerMedia.GET(new Request(signed), { params: { id: assetId } });
  assert.equal(signedImage.status, 200);
  assert.deepEqual(Buffer.from(await signedImage.arrayBuffer()), image);
  signed.searchParams.delete('signature');
  assert.equal((await providerMedia.GET(new Request(signed), { params: { id: assetId } })).status, 404);

  phase = 'original replay and private delivery';
  const replay = await read(await call('POST', 'video/tasks', winner.key, winner.body, winner.id));
  assert.equal(replay.body.id, accepted.id);
  assert.equal(creates, 1);
  const finalized = await finalizeVideoTaskStatus(receipt.task_id, { cacheOnSuccess: true, generateThumbnail: false });
  const ready = await read(await call('GET', 'video/tasks/' + accepted.id, winner.key));
  assert.equal(ready.body.delivery_status, 'ready', JSON.stringify({ response: ready, cache: finalized.cacheResult?.error,
    taskDelivery: finalized.task?.delivery_status, providerError: finalized.providerError }));
  assert.equal(ready.body.charged_points, 1);
  const file = await call('GET', 'video/tasks/' + accepted.id + '/content', winner.key);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), mp4);
  const range = await call('GET', 'video/tasks/' + accepted.id + '/content', winner.key, undefined, null, { range: 'bytes=0-15' });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), mp4.subarray(0, 16));
  const usage = await read(await call('GET', 'usage?agent_id=' + accepted.agent_id, winner.key));
  assert.equal(usage.body.records[0].charged_points, 1);
  assert.equal(await prisma.creditLedger.count({ where: { type: 'task_success_deduct' } }), 1);

  phase = 'delivery recovery and closing new admissions';
  await prisma.apiRequest.update({ where: { id: receipt.id }, data: { output_version: 'unavailable-original-fixture' } });
  const failedDelivery = await read(await call('GET', 'video/tasks/' + accepted.id, winner.key));
  assert.equal(failedDelivery.body.delivery_status, 'failed');
  assert.equal(failedDelivery.body.retry_after_seconds, null);
  const recovery = await read(await call('POST', 'video/tasks/' + accepted.id + '/recover-delivery', winner.key));
  assert.equal(recovery.code, 202, JSON.stringify(recovery));
  assert.equal(recovery.body.delivery_status, 'pending');
  await finalizeVideoTaskStatus(receipt.task_id, { cacheOnSuccess: true, generateThumbnail: false });
  const recovered = await read(await call('GET', 'video/tasks/' + accepted.id, winner.key));
  assert.equal(recovered.body.delivery_status, 'ready');
  assert.equal(recovered.body.content_sha256, ready.body.content_sha256);
  assert.equal(await prisma.creditLedger.count({ where: { type: 'task_success_deduct' } }), 1);
  assert.equal(creates, 1);
  await prisma.apiConfiguration.update({ where: { id: 'global' }, data: { enabled: false } });
  assert.equal((await call('POST', 'video/quotes', winner.key, { input, max_cost_points: 1 })).status, 403);
  assert.equal((await call('GET', 'video/tasks/' + accepted.id + '/content', winner.key)).status, 200);
  await prisma.apiConfiguration.update({ where: { id: 'global' }, data: { enabled: true } });

  phase = 'durable rejection and lost submission recovery';
  const rejected = await read(await call('POST', 'video/tasks', other.key, other.body, other.id));
  assert.equal(rejected.code, 402, JSON.stringify(rejected));
  const rejectedLookup = await read(await call('GET', 'video/requests/' + other.id, other.key));
  assert.equal(rejectedLookup.body.retry, 'same_request');
  await prisma.creditAccount.update({ where: { user_id: team.user.id }, data: { balance: { increment: 1 } } });
  loseSubmissionResponse = true;
  const unknown = await read(await call('POST', 'video/tasks', other.key, other.body, other.id));
  assert.equal(unknown.body.status, 'submission_unconfirmed', JSON.stringify(unknown));
  assert.equal(unknown.body.fee_status, 'reserved');
  assert.equal(creates, 2);
  const callbackRequest = new Request(acceptedInput.callback_url, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'fixture-provider-2' }) });
  const attached = await callback.POST(callbackRequest, { params: { id: acceptedInput.client_request_id } });
  assert.equal(attached.status, 204, await attached.text());
  const known = await read(await call('GET', 'video/requests/' + other.id, other.key));
  assert.notEqual(known.body.status, 'submission_unconfirmed');
  const credential = await prisma.apiProviderCredential.findFirst();
  assert(credential.configuration_json.startsWith('ppenc:v1:'));
  assert(!credential.configuration_json.includes('synthetic-upstream-key'));
  await mutateApiAdmin(admin.id, { action: 'revoke_key', operation_id: 'fixture-revoke-original',
    customer_id: team.customer.id, revision: team.customer.revision, key_id: first.id, confirm_revoke: true });
  assert.equal((await apiAdminSnapshot(team.customer.id)).customer.has_bound_key, false);
  assert.equal((await call('GET', 'models', first)).status, 401);
  const replacement = await issue(team.customer, 'replacement-key');
  assert.equal((await call('GET', 'video/tasks/' + accepted.id + '/content', replacement)).status, 200);
  assert.equal(await prisma.apiKey.count({ where: { customer_id: team.customer.id, active: true } }), 1);
  console.log('PASS single-Key binding and revocation, billing, original replay, isolation, private media and recovery.');
}

main().catch(error => {
  console.error('Customer API fixture failed in ' + phase, error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma?.$disconnect();
  process.chdir(root);
  fs.rmSync(fixture, { recursive: true, force: true });
  if (storageFixture) fs.rmSync(storageFixture, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
});
