import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { mock } from 'node:test';
import type { RetryScope, RetryRule } from '../src/lib/generation-retry/contracts';

async function main() {
  const root = process.cwd();
  fs.mkdirSync(path.join(root, '.role-tests'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, '.role-tests/safe-retry-'));
  process.env.DATABASE_URL = `file:${directory}/synthetic.db`;
  process.env.SEEDANCE_API_KEY = 'synthetic-never-a-real-key';
  process.env.SEEDANCE_BASE_URL = 'https://supplier.fixture.invalid/api';
  Reflect.set(process.env, 'NODE_ENV', 'test');
  execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')],
    { cwd: directory, env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' }, stdio: 'pipe' });
  const { prisma } = await import('../src/lib/prisma');
  process.chdir(directory);
  const blocked = () => { throw new Error('Real network forbidden in retry fixture'); };
  mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked);
  globalThis.fetch = async () => { throw new Error('Unconfigured fixture fetch'); };
  const policy = await import('../src/lib/generation-retry/contracts');
  const store = await import('../src/lib/generation-retry/store');
  const image = await import('../src/lib/generation-retry/image');
  const tasks = await import('../src/lib/image-studio/tasks');
  const delivery = await import('../src/lib/image-studio/delivery');
  const video = await import('../src/lib/generation-retry/video');
  const control = await import('../src/lib/generation-retry/control');
  const rules = policy.RETRY_RULES as RetryRule[];
  assert.equal(rules.length, 0, 'Production registry must start empty');
  const checks: string[] = [];
  const config = async (ids: string[]) => prisma.platformSetting.upsert({ where: { key: policy.RETRY_CONFIG_KEY },
    create: { key: policy.RETRY_CONFIG_KEY, value_json: JSON.stringify({ revision: randomUUID(), enabledIds: ids }) },
    update: { value_json: JSON.stringify({ revision: randomUUID(), enabledIds: ids }) } });
  const user = async () => {
    const id = randomUUID();
    await prisma.user.create({ data: { id, name: 'synthetic', username: id, email: `${id}@fixture.invalid`, password_hash: 'not-a-password', status: 'active' } });
    await prisma.creditAccount.create({ data: { user_id: id, balance: 100, frozen_credits: 5 } });
    return id;
  };
  const imageTask = async () => {
    const id = randomUUID(), owner = await user();
    return prisma.imageStudioTask.create({ data: { id, batch_id: id, owner_id: owner, ordinal: 1, fingerprint: id, prompt: 'fixture', context: '',
      revision: 0, model: 'gpt-image-2.5-sunburst', reference_ids: '[]', unit_credits: 5, status: 'sr_running',
      snapshot_json: JSON.stringify({ safeRetryRuleIds: ['fixture-image@1'] }), freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 5 }]),
      lease_token: randomUUID(), lease_until: new Date(Date.now() + 60000) } });
  };
  const scope: RetryScope = { provider: 'ai_media_vip', protocol: 'openai_images', endpoint: 'generations', model: 'gpt-image-2.5-sunburst',
    channel: 'original', revision: '0', credential: store.retryHash('https://supplier.fixture.invalid\nsynthetic') };
  const { credential: _credential, ...ruleScope } = scope;
  rules.push({ id: 'fixture-image', version: '1', scope: ruleScope, phase: 'create', httpStatus: 503, code: 'TEMP_FREE', terminal: true, noCharge: true, evidence: 'https://fixture.invalid/contract' });
  await config(['fixture-image']);
  const params = { baseUrl: 'https://supplier.fixture.invalid', apiKey: 'synthetic', provider: 'ai_media_vip' as const, protocol: 'openai_images' as const,
    model: scope.model, prompt: 'fixture', count: 1, images: [], signal: AbortSignal.timeout(60000) };
  const dueNow = async (kind: 'image' | 'video', id: string) => {
    await store.mutateRetry(kind, id, value => { value.dueAt = new Date(0).toISOString(); });
    if (kind === 'image') await prisma.imageStudioTask.update({ where: { id }, data: { lease_until: new Date(0) } });
  };
  try {
    for (const [label, failedAttempts, success] of [['first-success', 0, true], ['fourth-success', 3, true], ['four-failures', 4, false]] as const) {
      let task = await imageTask(), sends = 0;
      while (true) {
        await delivery.beginStudioRequest(task);
        const generate = image.imageRetryGenerator(task, async () => {
          sends++;
          if (sends <= failedAttempts) throw Object.assign(new Error('synthetic'), { retryFailure: policy.retryFailure({ code: 'TEMP_FREE' }, 503) });
          return { images: ['synthetic-output-not-a-media-test'], usage: {} };
        });
        try { await generate(params); await tasks.finishStudioTask(task, 'succeeded'); break; }
        catch (error) {
          if (error instanceof image.RetryExhausted) { await tasks.finishStudioTask(task, 'failed'); break; }
          assert.ok(error instanceof image.RetryScheduled);
          const account = await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: task.owner_id } });
          assert.equal(account.frozen_credits, 5);
          assert.equal(await prisma.creditLedger.count({ where: { related_task_id: task.id } }), 0);
          await dueNow('image', task.id); await image.promoteImageRetry();
          const claimed = await tasks.claimStudioTask(); assert.ok(claimed); assert.equal(claimed.id, task.id); task = claimed;
        }
      }
      assert.equal(sends, failedAttempts === 4 ? 4 : failedAttempts + 1);
      const record = (await store.readRetry('image', task.id))!.value;
      assert.equal(record.attempts.length, sends); assert.equal(record.state, success ? 'succeeded' : 'failed');
      assert.equal(new Set(record.attempts.map(a => a.key)).size, sends);
      assert.equal(await prisma.creditLedger.count({ where: { related_task_id: task.id } }), 1);
      const account = await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: task.owner_id } });
      assert.equal(account.frozen_credits, 0); checks.push(`image_${label}_durable_single_settlement`);
    }
    const unknown = await imageTask();
    const unknownGenerate = image.imageRetryGenerator(unknown, async () => { throw new Error('network timeout'); });
    await assert.rejects(unknownGenerate(params));
    await tasks.finishStudioTask(unknown, 'uncertain');
    assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: unknown.owner_id } })).frozen_credits, 5);
    assert.equal((await store.readRetry('image', unknown.id))!.value.state, 'unknown');
    await assert.rejects(store.markRetrySent('image', unknown.id));
    checks.push('unknown_timeout_never_resends_or_refunds');

    const stopped = await imageTask();
    const failed = image.imageRetryGenerator(stopped, async () => { throw Object.assign(new Error('synthetic'), { retryFailure: policy.retryFailure({ code: 'TEMP_FREE' }, 503) }); });
    await assert.rejects(failed(params), image.RetryScheduled);
    await assert.rejects(control.stopTaskRetries('image', stopped.id, 'different-owner'));
    await control.stopTaskRetries('image', stopped.id, stopped.owner_id);
    await control.stopTaskRetries('image', stopped.id, stopped.owner_id);
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: stopped.id } }), 1);
    checks.push('owner_only_idempotent_stop_single_refund');
    assert.equal(policy.matchingRetryRule(scope, policy.retryFailure({ code: 'QUOTA_EXHAUSTED' }, 503), ['fixture-image@1'], ['fixture-image']), undefined);
    assert.equal(policy.matchingRetryRule(scope, policy.retryFailure({ code: 'TEMP_FREE' }, 429), ['fixture-image@1'], ['fixture-image']), undefined);
    checks.push('exact_error_and_http_not_text_or_quota');

    const id = randomUUID(), owner = await user();
    const task = await prisma.videoTask.create({ data: { id, provider: 'seedance', model: 'dreamina-seedance-2-0-260128', generation_mode: 'all_in_one_reference',
      prompt: 'fixture', user_id: owner, owner_user_id: owner, local_status: 'submitted', estimated_cost: 5, frozen_cost: 5,
      credit_freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 5 }]) } });
    const frozen = await video.freezeVideoRetry(task, { provider: 'seedance', input: { model: task.model, generation_mode: 'all_in_one_reference', prompt: 'fixture' }, privateOrigins: [], sensitiveRecipe: false });
    const videoRecord = (await store.readRetry('video', id))!.value;
    const { credential: _videoCredential, ...videoScope } = videoRecord.scope;
    rules.push({ id: 'fixture-video', version: '1', scope: videoScope, phase: 'create', httpStatus: 503, code: 'TEMP_FREE', terminal: true, noCharge: true, evidence: 'https://fixture.invalid/video-contract' });
    await config(['fixture-image', 'fixture-video']);
    await store.mutateRetry('video', id, value => { value.ruleIds = ['fixture-video@1']; });
    let posts = 0;
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST' && new URL(String(url)).pathname.endsWith('/call')) {
        posts++;
        return posts < 4 ? Response.json({ code: 'TEMP_FREE' }, { status: 503 }) : Response.json({ id: 'fixture-video-accepted' });
      }
      return Response.json({ id: 'fixture-video-accepted', status: 'succeeded', content: { video_url: 'https://result.fixture.invalid/video.mp4' } });
    };
    await assert.rejects(video.dispatchFrozenVideoRetry(task, frozen), video.SafeVideoPending);
    for (let i = 0; i < 3; i++) { await dueNow('video', id); await video.processVideoRetries(); }
    assert.equal(posts, 4);
    const completed = await prisma.videoTask.findUniqueOrThrow({ where: { id } });
    assert.equal(completed.local_status, 'succeeded');
    assert.equal((await store.readRetry('video', id))!.value.attempts.length, 4);
    assert.equal(completed.frozen_cost, 0); assert.equal(completed.actual_cost, 5);
    await video.processVideoRetries(); assert.equal(posts, 4);
    checks.push('video_real_adapter_background_four_attempts_success_stop_single_charge');
    const stopOwner = await user(), stopId = randomUUID();
    await prisma.videoTask.create({ data: { id: stopId, provider: 'seedance', model: task.model, generation_mode: 'all_in_one_reference', prompt: 'fixture',
      user_id: stopOwner, owner_user_id: stopOwner, local_status: 'retry_wait', estimated_cost: 5, frozen_cost: 5,
      credit_freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 5 }]) } });
    await store.beginRetry({ kind: 'video', taskId: stopId, ownerId: stopOwner, inputHash: 'synthetic', scope: videoRecord.scope });
    await store.mutateRetry('video', stopId, value => { value.state = 'wait'; value.attempts[0].state = 'free_failed'; });
    await control.stopTaskRetries('video', stopId, stopOwner);
    await control.stopTaskRetries('video', stopId, stopOwner);
    const stoppedVideo = await prisma.videoTask.findUniqueOrThrow({ where: { id: stopId } });
    assert.equal(stoppedVideo.refund_amount, 5); assert.equal(stoppedVideo.frozen_cost, 0);
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: stopId } }), 1);
    checks.push('video_stop_and_refund_atomic_idempotent_preserves_receipt');
    const lateOwner = await user(), lateId = randomUUID();
    const lateTask = await prisma.videoTask.create({ data: { id: lateId, provider: 'seedance', model: task.model,
      generation_mode: 'all_in_one_reference', prompt: 'fixture', user_id: lateOwner, owner_user_id: lateOwner,
      provider_task_id: 'fixture-late-original', local_status: 'retry_wait', estimated_cost: 5, frozen_cost: 5,
      credit_freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 5 }]) } });
    await video.freezeVideoRetry(lateTask, { provider: 'seedance', input: { model: task.model, generation_mode: 'all_in_one_reference', prompt: 'fixture' }, privateOrigins: [], sensitiveRecipe: false });
    await prisma.videoTask.update({ where: { id: lateId }, data: { local_status: 'retry_wait' } });
    await store.mutateRetry('video', lateId, value => { value.state = 'wait'; value.attempts[0].state = 'free_failed'; value.attempts[0].providerTaskId = 'fixture-late-original'; });
    globalThis.fetch = async url => {
      if (new URL(String(url)).pathname.endsWith('/call')) { posts++; throw new Error('Late success must not generate'); }
      return Response.json({ id: 'fixture-late-original', status: 'succeeded', content: { video_url: 'https://result.fixture.invalid/original.mp4' } });
    };
    assert.equal(await video.observeRetryCallback(lateTask, 'fixture-late-original'), true);
    assert.equal((await store.readRetry('video', lateId))!.value.state, 'unknown');
    assert.equal((await prisma.videoTask.findUniqueOrThrow({ where: { id: lateId } })).local_status, 'submission_unknown');
    await control.stopTaskRetries('video', lateId, lateOwner);
    await video.processVideoRetries();
    assert.equal(posts, 4);
    assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: lateOwner } })).frozen_credits, 5);
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: lateId } }), 0);
    assert.ok(fs.existsSync(path.join(directory, 'storage/generation-retry', lateId, 'late-attempt-0.json')));
    checks.push('late_original_success_stops_wait_and_stale_stop_keeps_unknown_reserve');
    const legacy = await prisma.videoTask.create({ data: { provider: 'seedance', model: task.model, generation_mode: 'text_to_video', prompt: 'legacy', local_status: 'failed' } });
    assert.equal(await store.readRetry('video', legacy.id), null);
    checks.push('legacy_not_adopted_or_replayed');
    console.log(JSON.stringify({ task: 'SAFE-RETRY01', checks, syntheticOnly: true, paidRequests: 0, browserAcceptance: false, productionRules: 0, database: `${directory}/synthetic.db` }, null, 2));
  } finally { rules.splice(0); await prisma.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
