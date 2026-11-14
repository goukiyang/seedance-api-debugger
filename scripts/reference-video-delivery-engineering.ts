import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function main() {
  const root = process.cwd(), scratch = path.join(root, '.role-tests');
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(scratch, 'reference-video-delivery-'));
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${directory}/synthetic.db`,
    SESSION_SECRET: randomBytes(32).toString('hex'), SITE_PUBLIC_BASE_URL: 'https://reference-video.fixture.invalid',
    SEEDANCE_API_KEY: 'synthetic-key-never-real', SEEDANCE_BASE_URL: 'https://provider.fixture.invalid/api',
    PROVIDER_REFERENCE_MEDIA_ORDINARY_ENABLED: '1', PROVIDER_REFERENCE_MEDIA_IP_ENABLED: '1' });
  execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory,
    env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' }, stdio: 'pipe' });
  const require = createRequire(import.meta.url);
  const { prisma } = require('../src/lib/prisma') as typeof import('../src/lib/prisma');
  const delivery = require('../src/lib/provider/reference-video-delivery.server') as typeof import('../src/lib/provider/reference-video-delivery.server');
  const reader = require('../src/app/api/provider/reference-media/route') as typeof import('../src/app/api/provider/reference-media/route');
  const video = require('../src/lib/generation-retry/video') as typeof import('../src/lib/generation-retry/video');
  const store = require('../src/lib/generation-retry/store') as typeof import('../src/lib/generation-retry/store');
  const ledger = require('../src/lib/costs/ledger') as typeof import('../src/lib/costs/ledger');
  const policy = require('../src/lib/generation-retry/contracts') as typeof import('../src/lib/generation-retry/contracts');
  const metadata = require('../src/lib/provider/ip-reference-media-metadata') as typeof import('../src/lib/provider/ip-reference-media-metadata');
  const routeSource = await fs.readFile(path.join(root, 'src/app/api/tasks/create/route.ts'), 'utf8');
  const routeAst = ts.createSourceFile('create.ts', routeSource, ts.ScriptTarget.Latest, true);
  let createCatch: ts.CatchClause | undefined, privateHeaders: ts.FunctionDeclaration | undefined;
  const visitCreate = (node: ts.Node) => {
    if (ts.isCatchClause(node) && node.block.getText(routeAst).includes('err instanceof SafeVideoPreparationFailed')
      && node.block.getText(routeAst).includes('retainVideoPendingDiagnostic')) createCatch = node;
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'privateNoStore') privateHeaders = node;
    ts.forEachChild(node, visitCreate);
  };
  visitCreate(routeAst); assert.ok(createCatch && privateHeaders);
  const createFixture: { exports?: (...args: any[]) => Promise<Response> } = {};
  runInNewContext(ts.transpileModule(`${privateHeaders.getText(routeAst)}\nasync function fixture(err, taskId, providerRequestId) ${createCatch.block.getText(routeAst)}\nmodule.exports = fixture;`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module: createFixture, SafeVideoPreparationFailed: video.SafeVideoPreparationFailed, SafeVideoPending: video.SafeVideoPending,
      retainVideoPendingDiagnostic: video.retainVideoPendingDiagnostic, markProviderApiRequestFailed: ledger.markProviderApiRequestFailed,
      NextResponse: require('next/server').NextResponse });
  const runInitialCatch = createFixture.exports!;
  const ipSource = await fs.readFile(path.join(root, 'src/app/api/ip/tasks/create/route.ts'), 'utf8');
  const ipAst = ts.createSourceFile('ip-create.ts', ipSource, ts.ScriptTarget.Latest, true);
  let ipSendStatements: readonly ts.Statement[] | undefined;
  const visitIp = (node: ts.Node) => {
    if (ts.isBlock(node)) {
      const index = node.statements.findIndex(statement => ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some(declaration => declaration.name.getText(ipAst) === 'deliveredVideoUrls'));
      if (index >= 0) ipSendStatements = node.statements.slice(index, index + 5);
    }
    ts.forEachChild(node, visitIp);
  };
  visitIp(ipAst); assert.ok(ipSendStatements && ipSendStatements.length === 5);
  const ip = require('../src/lib/provider/volcengine-ip') as typeof import('../src/lib/provider/volcengine-ip');
  let ipPosts = 0, ipPayload: any;
  const ipFixture: { exports?: (...args: any[]) => Promise<any> } = {};
  runInNewContext(ts.transpileModule(`async function fixture(taskId,user,providerInput,referenceVideoDelivery,ipReferenceTransport,selectedModel,videoGroups) { let submissionStarted=false,providerResult=null,providerTaskId=null; ${ipSendStatements.map(statement => statement.getText(ipAst)).join('\n')} return {submissionStarted,providerResult,providerTaskId}; } module.exports=fixture;`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module: ipFixture, Date, prepareReferenceVideoDelivery: delivery.prepareReferenceVideoDelivery,
      createVolcengineIpVideoTask: (input: any, options: any) => ip.createVolcengineIpVideoTask(input, { ...options,
        apiKey: 'synthetic-ark-key', model: 'doubao-seedance-2-5-260628', baseUrl: 'https://ark.fixture.invalid/api/v3', fetchImpl: async (_url, init) => {
          ipPosts++; ipPayload = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ id: 'synthetic-ip-id', echo: ipPayload.content.find((item: any) => item.type === 'video_url').video_url.url }), { status: 200 });
        } }) });
  process.chdir(directory);
  const blocked = () => { throw new Error('Real network forbidden in isolated delivery fixture'); };
  mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked);
  const checks: string[] = [];
  let providerPosts = 0;
  let providerReply = (_body: Record<string, any>): Response => new Response(JSON.stringify({ id: 'synthetic-provider-id' }), { status: 200 });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://provider.fixture.invalid/api/call');
    assert.equal(init?.method, 'POST'); providerPosts += 1;
    return providerReply(JSON.parse(String(init?.body)));
  };
  const user = async () => {
    const id = randomUUID();
    const row = await prisma.user.create({ data: { id, name: 'synthetic', username: id, email: `${id}@fixture.invalid`, password_hash: 'not-a-password', status: 'active' } });
    await prisma.creditAccount.create({ data: { user_id: id, balance: 100, frozen_credits: 0 } });
    return { ...row, role: 'user' as const, account_type: 'internal' as const, status: 'active' as const };
  };
  const owner = await user(), peer = await user();
  await fs.mkdir('public/uploads/assets', { recursive: true });
  const file = path.join(directory, 'public/uploads/assets/reference.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x640:r=24:d=2.2',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'pipe', timeout: 30000 });
  const bytes = await fs.readFile(file), hash = createHash('sha256').update(bytes).digest('hex');
  const original = 'https://reference-video.fixture.invalid/uploads/assets/reference.mp4';
  const asset = await prisma.asset.create({ data: { id: randomUUID(), owner_id: owner.id, type: 'video', original_url: original,
    file_name: 'reference.mp4', mime_type: 'video/mp4', file_size: bytes.length, hash } });
  const input = { prompt: 'synthetic', model: 'dreamina-seedance-2-0-260128', generation_mode: 'all_in_one_reference' as const,
    reference_video_urls: [original, 'https://external.fixture.invalid/video.mp4'], duration: 5 as const };
  const task = async (actor = owner, provider = 'seedance') => {
    await prisma.creditAccount.update({ where: { user_id: actor.id }, data: { frozen_credits: { increment: 5 } } });
    return prisma.videoTask.create({ data: { id: randomUUID(), provider, model: input.model, generation_mode: input.generation_mode,
      prompt: 'synthetic', user_id: actor.id, owner_user_id: actor.id, local_status: 'submitted', estimated_cost: 5, frozen_cost: 5,
      reference_video_urls: JSON.stringify(input.reference_video_urls), credit_freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 5 }]) } });
  };
  const tokenInfo = (url: string) => JSON.parse(Buffer.from(new URL(url).searchParams.get('ticket')!.split('.')[0], 'base64url').toString());
  try {
    await assert.rejects(delivery.authorizeLocalReferenceVideos(peer, [original]));
    const album = await prisma.referenceAlbum.create({ data: { owner_user_id: owner.id, name: 'synthetic-use' } });
    await prisma.referenceImage.create({ data: { album_id: album.id, owner_user_id: owner.id, asset_id: asset.id, url: original } });
    const share = await prisma.albumShare.create({ data: { album_id: album.id, grantee_type: 'user', grantee_id: peer.id,
      created_by: owner.id, permissions_json: JSON.stringify({ view: true, use: false }) } });
    await assert.rejects(delivery.authorizeLocalReferenceVideos(peer, [original]), 'view is not use');
    await prisma.albumShare.update({ where: { id: share.id }, data: { permissions_json: JSON.stringify({ view: true, use: true }) } });
    assert.equal((await delivery.authorizeLocalReferenceVideos(peer, [original]))[0].assetId, asset.id);
    checks.push('actual_owner_and_album_use_grants_preview_is_not_use');

    const authorized = await delivery.authorizeLocalReferenceVideos(owner, input.reference_video_urls);
    const plan = (await delivery.planReferenceVideoDelivery(owner, input, 'ordinary', authorized))!;
    assert.equal(plan.executionSeconds, 172800);
    assert.equal((await delivery.planReferenceVideoDelivery(owner, { ...input, execution_expires_after: 3600 }, 'ordinary', authorized))!.executionSeconds, 3600);
    assert.equal(delivery.referenceVideoExecutionSeconds(259200), 259200);
    assert.throws(() => delivery.referenceVideoExecutionSeconds(3599));
    assert.throws(() => delivery.referenceVideoExecutionSeconds(259201));
    const freshTask = await task();
    const issuedAt = Date.now(), urls = await delivery.prepareReferenceVideoDelivery(freshTask.id, owner, input.reference_video_urls, plan, issuedAt);
    assert.equal(urls[1], input.reference_video_urls[1]);
    assert.equal(new URL(urls[0]).origin, process.env.SITE_PUBLIC_BASE_URL);
    assert.equal(tokenInfo(urls[0]).expires - issuedAt, 172800000 + 300000);
    assert.deepEqual(await delivery.prepareReferenceVideoDelivery(freshTask.id, owner, input.reference_video_urls, plan, issuedAt), urls);
    checks.push('original_window_default_explicit_range_canonical_host_external_unchanged_no_renew');
    const guardExports: Record<string, any> = {};
    const deliveryRequire = createRequire(path.join(root, 'src/lib/provider/reference-video-delivery.server.ts'));
    runInNewContext(ts.transpileModule(await fs.readFile(path.join(root, 'src/lib/provider/reference-video-delivery.server.ts'), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
      { exports: guardExports, require: (name: string) => name === './reference-video-delivery-build-mode'
        ? { PROVIDER_REFERENCE_MEDIA_ISSUANCE_ENABLED: false } : deliveryRequire(name), process, Buffer, URL, Response, Date });
    await assert.rejects(guardExports.planReferenceVideoDelivery(owner, input, 'ordinary', authorized));
    assert.equal(await guardExports.planReferenceVideoDelivery(owner, { ...input, reference_video_urls: [input.reference_video_urls[1]] }, 'ordinary'), undefined);
    assert.equal(await guardExports.planReferenceVideoDelivery(owner, { ...input, reference_video_urls: [] }, 'ordinary'), undefined);
    assert.deepEqual(await guardExports.prepareReferenceVideoDelivery(freshTask.id, owner, input.reference_video_urls, plan, issuedAt), urls);
    assert.equal((await guardExports.providerReferenceVideoResponse(new Request(urls[0], { method: 'HEAD' }))).status, 200);
    checks.push('actual_guard_plan_rejects_new_local_before_send_external_empty_unchanged_marked_reader_recovery');


    const head = await reader.HEAD(new Request(urls[0], { method: 'HEAD', headers: { host: 'untrusted.fixture.invalid' } }));
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.match(head.headers.get('X-Media-Request-Id')!, /^[a-f0-9-]{36}$/); assert.equal(await head.text(), '');
    for (const range of ['bytes=0-15', 'bytes=16-31', 'bytes=-8']) {
      const response = await reader.GET(new Request(urls[0], { headers: { Range: range } }));
      assert.equal(response.status, 206);
      const actual = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(actual, range === 'bytes=-8' ? bytes.subarray(-8) : range === 'bytes=0-15' ? bytes.subarray(0, 16) : bytes.subarray(16, 32));
    }
    const bad = new URL(urls[0]); bad.searchParams.set('ticket', bad.searchParams.get('ticket')!.slice(0, -1) + '!');
    const denied = await reader.GET(new Request(bad)); assert.equal(denied.status, 403); assert.ok(denied.headers.get('X-Media-Request-Id'));
    const clock = Date.now;
    Date.now = () => tokenInfo(urls[0]).expires + 1;
    try { assert.equal((await reader.HEAD(new Request(urls[0], { method: 'HEAD' }))).status, 403); } finally { Date.now = clock; }
    await prisma.asset.update({ where: { id: asset.id }, data: { hash: 'a'.repeat(64) } });
    assert.equal((await reader.GET(new Request(urls[0]))).status, 403);
    await prisma.asset.update({ where: { id: asset.id }, data: { hash } });
    await prisma.user.update({ where: { id: owner.id }, data: { status: 'disabled' } });
    assert.equal((await reader.GET(new Request(urls[0]))).status, 403);
    await prisma.user.update({ where: { id: owner.id }, data: { status: 'active' } });
    await prisma.videoTask.update({ where: { id: freshTask.id }, data: { retention_status: 'user_deleted' } });
    assert.equal((await reader.HEAD(new Request(urls[0], { method: 'HEAD' }))).status, 200);
    process.env.PROVIDER_REFERENCE_MEDIA_ORDINARY_ENABLED = '0';
    await assert.rejects(delivery.planReferenceVideoDelivery(owner, input, 'ordinary', authorized));
    assert.equal((await reader.HEAD(new Request(urls[0], { method: 'HEAD' }))).status, 200);
    process.env.PROVIDER_REFERENCE_MEDIA_ORDINARY_ENABLED = '1';
    Reflect.set(process.env, 'NODE_ENV', 'production');
    try {
      await fs.writeFile('.env', 'PROVIDER_REFERENCE_MEDIA_ORDINARY_ENABLED=0\nPROVIDER_REFERENCE_MEDIA_IP_ENABLED=0\n');
      await assert.rejects(delivery.planReferenceVideoDelivery(owner, input, 'ordinary', authorized));
      await fs.writeFile('.env', 'PROVIDER_REFERENCE_MEDIA_ORDINARY_ENABLED=1\nPROVIDER_REFERENCE_MEDIA_IP_ENABLED=0\n');
      process.env.PROVIDER_REFERENCE_MEDIA_ORDINARY_ENABLED = '0';
      assert.ok(await delivery.planReferenceVideoDelivery(owner, input, 'ordinary', authorized));
      await assert.rejects(delivery.planReferenceVideoDelivery(owner, input, 'ip', authorized));
      await fs.writeFile('.env', 'PROVIDER_REFERENCE_MEDIA_ORDINARY_ENABLED=0\nPROVIDER_REFERENCE_MEDIA_IP_ENABLED=1\n');
      await assert.rejects(delivery.planReferenceVideoDelivery(owner, input, 'ordinary', authorized));
      assert.ok(await delivery.planReferenceVideoDelivery(owner, input, 'ip', authorized));
      assert.equal((await reader.HEAD(new Request(urls[0], { method: 'HEAD' }))).status, 200);
      assert.equal(await delivery.planReferenceVideoDelivery(owner, { ...input, reference_video_urls: [] }, 'ordinary'), undefined);
      assert.equal(await delivery.planReferenceVideoDelivery(owner, { ...input, reference_video_urls: [input.reference_video_urls[1]] }, 'ordinary'), undefined);
      await fs.unlink('.env');
      await assert.rejects(delivery.planReferenceVideoDelivery(owner, input, 'ordinary', authorized));
    } finally { Reflect.set(process.env, 'NODE_ENV', 'test'); process.env.PROVIDER_REFERENCE_MEDIA_ORDINARY_ENABLED = '1'; }
    checks.push('production_fresh_dotenv_activation_after_handoff_family_isolation_missing_gate_rejects_reader_survives');
    const secret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'dev-secret-change-in-production';
    await assert.rejects(delivery.planReferenceVideoDelivery(owner, input, 'ordinary', authorized));
    process.env.SESSION_SECRET = secret;
    checks.push('real_handler_head_range_tamper_expiry_source_owner_revocation_hide_not_revoke_offgate_reader');

    const probed = await metadata.probeIpReferenceMedia([original], 'video', authorized);
    assert.equal(probed[0].width, 640); assert.equal(probed[0].height, 640); assert.equal(probed[0].fps, 24);
    assert.ok(probed[0].durationSeconds! > 2); await assert.rejects(metadata.probeIpReferenceMedia([original], 'video'));
    checks.push('authorized_local_ffprobe_no_anonymous_self_fetch');
    const ipTask = await task(owner, 'volcengine_ark');
    const ipPlan = (await delivery.planReferenceVideoDelivery(owner, input, 'ip', authorized))!;
    const ipResult = await ipFixture.exports!(ipTask.id, owner, { ...input, model: 'doubao-seedance-2-5-260628' }, ipPlan, {}, 'doubao-seedance-2-5-260628', { origins: [] });
    assert.equal(ipPosts, 1); assert.equal(ipResult.submissionStarted, true); assert.equal(ipResult.providerTaskId, 'synthetic-ip-id');
    assert.match(ipPayload.content.filter((item: any) => item.type === 'video_url')[0].video_url.url, /\/api\/provider\/reference-media\?ticket=/);
    assert.equal(ipPayload.content.filter((item: any) => item.type === 'video_url')[1].video_url.url, input.reference_video_urls[1]);
    assert.equal((await prisma.videoTask.findUniqueOrThrow({ where: { id: ipTask.id } })).reference_video_urls, JSON.stringify(input.reference_video_urls));
    assert.ok(!JSON.stringify(ipResult.providerResult.raw).includes('ticket='));
    checks.push('actual_ip_create_send_glue_ordered_adapter_before_post_original_urls_retained');


    // These tasks exercise the actual send/worker handlers against only the temporary DB and file.
    for (const mode of ['initial', 'worker-first', 'worker-later'] as const) {
      const candidate = await task();
      const frozen = await video.freezeVideoRetry(candidate, { provider: 'seedance', input, privateOrigins: [], sensitiveRecipe: false, referenceVideoDelivery: plan });
      if (mode === 'worker-later') {
        await prisma.platformSetting.upsert({ where: { key: policy.RETRY_CONFIG_KEY }, create: { key: policy.RETRY_CONFIG_KEY,
          value_json: JSON.stringify({ revision: 'synthetic', enabledIds: ['synthetic-video'] }) }, update: { value_json: JSON.stringify({ revision: 'synthetic', enabledIds: ['synthetic-video'] }) } });
        await store.mutateRetry('video', candidate.id, value => {
          value.state = 'wait'; value.dueAt = new Date(0).toISOString();
          value.attempts[0].state = 'free_failed'; value.attempts[0].rule = { id: 'synthetic-video', version: '1', evidence: 'https://fixture.invalid/contract' };
        });
        await prisma.$transaction(async tx => { await store.advanceRetry(tx, 'video', candidate.id); });
      }
      await fs.rename(file, file + '.held');
      const beforePosts = providerPosts;
      const initialRequest = mode === 'initial' ? await ledger.createProviderApiRequest({ task: candidate, endpoint: 'seedance.createVideoTask' }) : null;
      try {
        if (mode === 'initial') {
          let preparationError: unknown;
          try { await video.dispatchFrozenVideoRetry(candidate, frozen); } catch (error) { preparationError = error; }
          assert.ok(preparationError instanceof video.SafeVideoPreparationFailed);
          const response = await runInitialCatch(preparationError, candidate.id, initialRequest!.id);
          assert.equal(response.status, 400); assert.equal((await response.json()).error, 'REFERENCE_VIDEO_PREPARATION_FAILED');
        }
        else {
          await prisma.videoTask.update({ where: { id: candidate.id }, data: { updated_at: new Date(0) } });
          await video.processVideoRetries(); await video.processVideoRetries();
        }
      } finally { await fs.rename(file + '.held', file); }
      assert.equal(providerPosts, beforePosts);
      const final = await prisma.videoTask.findUniqueOrThrow({ where: { id: candidate.id } });
      assert.equal(final.local_status, 'failed'); assert.equal(final.error_code, 'REFERENCE_VIDEO_PREPARATION_FAILED');
      assert.equal((await store.readRetry('video', candidate.id))!.value.state, 'failed');
      assert.equal((await store.readRetry('video', candidate.id))!.value.attempts.at(-1)!.state, 'failed');
      assert.equal(await prisma.creditLedger.count({ where: { related_task_id: candidate.id } }), 1);
      plan.sources = await delivery.authorizeLocalReferenceVideos(owner, input.reference_video_urls);
      checks.push(`${mode}_unsent_zero_posts_closed_once_no_worker_loop`);
    }

    const unknown = await task(), request = await ledger.createProviderApiRequest({ task: unknown, endpoint: 'seedance.createVideoTask' });
    const frozen = await video.freezeVideoRetry(unknown, { provider: 'seedance', input, privateOrigins: [], sensitiveRecipe: false, referenceVideoDelivery: plan });
    providerReply = body => {
      const source = body.content.find((item: any) => item.type === 'video_url').video_url.url;
      assert.match(source, /\/api\/provider\/reference-media\?ticket=/);
      assert.equal(body.content.filter((item: any) => item.type === 'video_url')[1].video_url.url, input.reference_video_urls[1]);
      return new Response(JSON.stringify({ error: { code: 'InvalidParameter', param: 'content[1].video_url.url', message: `Failed to download ${source}: resource not found` } }), { status: 200 });
    };
    let pending: InstanceType<typeof video.SafeVideoPending> | undefined;
    try { await video.dispatchFrozenVideoRetry(unknown, frozen); } catch (error) { assert.ok(error instanceof video.SafeVideoPending); pending = error; }
    assert.ok(pending);
    const firstResponse = await runInitialCatch(pending, unknown.id, request.id);
    assert.equal(firstResponse.status, 202); assert.match((await firstResponse.json()).message, /无法读取参考视频/);
    const status = await prisma.videoTask.findUniqueOrThrow({ where: { id: unknown.id } });
    assert.equal(status.local_status, 'submission_unknown'); assert.match(status.error_message!, /无法读取参考视频/);
    assert.equal(status.frozen_cost, 5); assert.equal(status.actual_cost, null);
    const stored = await prisma.providerApiRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(stored.status, 'unknown'); assert.match(stored.response_summary_json!, /reference_unavailable/);
    assert.ok(!JSON.stringify(stored).includes('ticket='));
    const postsAfterUnknown = providerPosts; await video.processVideoRetries(); assert.equal(providerPosts, postsAfterUnknown);
    assert.deepEqual(frozen.input, input); assert.ok(!JSON.stringify(frozen).includes('ticket='));
    checks.push('known_http200_reason_unknown_fee_protection_durable_no_resend_original_frozen_urls');

    await prisma.videoTask.update({ where: { id: unknown.id }, data: { provider_task_id: 'late-accepted', local_status: 'succeeded', error_message: null } });
    await prisma.providerApiRequest.update({ where: { id: request.id }, data: { status: 'accepted', provider_task_id: 'late-accepted', response_summary_json: '{"accepted":true}' } });
    await video.retainVideoPendingDiagnostic(unknown.id, pending.state, pending.diagnostic, request.id);
    assert.equal((await prisma.videoTask.findUniqueOrThrow({ where: { id: unknown.id } })).local_status, 'succeeded');
    assert.equal((await prisma.providerApiRequest.findUniqueOrThrow({ where: { id: request.id } })).response_summary_json, '{"accepted":true}');
    checks.push('accepted_success_cas_precedence_over_late_error_projection');

    const workerUnknown = await task();
    await video.freezeVideoRetry(workerUnknown, { provider: 'seedance', input, privateOrigins: [], sensitiveRecipe: false, referenceVideoDelivery: plan });
    await prisma.videoTask.update({ where: { id: workerUnknown.id }, data: { updated_at: new Date(0) } });
    await video.processVideoRetries();
    const workerRequest = await prisma.providerApiRequest.findFirstOrThrow({ where: { task_id: workerUnknown.id } });
    assert.equal(workerRequest.status, 'unknown'); assert.match(workerRequest.response_summary_json!, /reference_unavailable/);
    assert.match((await prisma.videoTask.findUniqueOrThrow({ where: { id: workerUnknown.id } })).error_message!, /无法读取参考视频/);
    checks.push('actual_worker_outer_catch_retains_unknown_and_safe_reason');

    const sourceHashes = Object.fromEntries(await Promise.all(['src/lib/provider/reference-video-delivery.server.ts', 'src/lib/provider/reference-video-delivery-build-mode.ts',
      'src/app/api/provider/reference-media/route.ts', 'src/app/api/tasks/create/route.ts', 'src/app/api/ip/tasks/create/route.ts', 'src/lib/generation-retry/video.ts', 'src/lib/provider/ip-reference-media-metadata.ts']
      .map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
    await fs.writeFile(path.join(scratch, 'reference-video-delivery-receipt.json'), JSON.stringify({ checks, providerPosts, ipPosts,
      network: 'controlled fixture only; external blocked', sourceHashes }, null, 2));
    console.log(JSON.stringify({ status: 'PASS', checks, providerPosts }));
  } finally { await prisma.$disconnect(); mock.restoreAll(); process.chdir(root); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
