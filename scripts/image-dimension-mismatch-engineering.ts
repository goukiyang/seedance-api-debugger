import { setFixtureDatabase } from './fixtures/database-client';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';
import sharp from '../src/lib/media/sharp';
import type { SessionUser } from '../src/lib/auth/session';

process.exitCode = 1;
const deadline = setTimeout(() => process.exit(1), 180000); deadline.ref();
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const sourcePaths = ['src/lib/image-studio/dimension-rejection.ts', 'src/lib/image-studio/dimension-mismatch.ts',
  'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/output.ts', 'src/lib/image-studio/delivery.ts',
  'src/app/api/image-studio/assets/[assetId]/route.ts', 'src/app/api/image-studio/download/route.ts',
  'src/app/image-studio/studio.tsx', 'src/components/GeneratedImageResults.tsx', 'src/lib/image-studio/worker.ts',
  'src/app/api/image-studio/upload-access/route.ts', 'src/lib/image-studio/input-main.ts', 'src/lib/image-studio/result-pins.ts',
  'src/lib/image-studio/result-feed.ts', 'src/lib/image-studio/result-attention.ts', 'src/lib/image-studio/viewer-receipts.ts',
  'src/lib/image-result-next/server.ts', 'src/lib/assets/generation-origin.ts', 'src/lib/image-studio/modules.ts',
  'src/lib/image-studio/batches.ts', 'src/lib/image-studio/batch-contract.ts', 'src/app/image-studio/batch-results.tsx',
  'src/app/api/assets/picker/route.ts', 'src/app/api/assets/library/route.ts', 'src/lib/avatar-random/service.ts',
  'src/lib/avatar-random/handoff.ts', 'src/lib/canvas-roles/media.ts', 'src/lib/canvas-roles/media-bindings.ts',
  'src/app/api/avatar-studio/route.ts', 'src/app/tools/avatar-studio/studio.tsx', 'src/app/story-studio/story-studio.tsx'];
const checks: string[] = [];

async function main() {
  const root = realpathSync(process.cwd()), runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.match(runId || '', /^[a-f0-9-]{36}$/i);
  const startedAt = new Date().toISOString(), previousUmask = process.umask(0o077);
  const sourceSha256 = Object.fromEntries(sourcePaths.map(file => [file, sha(readFileSync(path.join(root, file)))]));
  const fixtureSha256 = sha(readFileSync(path.join(root, 'scripts/image-dimension-mismatch-engineering.ts')));
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'image-dimension-mismatch-')), databasePath = path.join(directory, 'synthetic.db');
  process.env.DATABASE_URL = `file:${databasePath}`; Reflect.set(process.env, 'NODE_ENV', 'test');
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const require = createRequire(import.meta.url), prismaPackage = require.resolve('prisma/package.json');
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) env[name] = process.env[name];
  execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  const { PrismaClient } = await import('@prisma/client'); const db = new PrismaClient(); setFixtureDatabase(db);
  process.chdir(directory);
  let forbiddenCalls = 0, completed = false;
  const blocked = () => { forbiddenCalls++; throw new Error('Fixture network is forbidden'); };
  mock.method(globalThis, 'fetch', blocked); mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked); mock.method(dns, 'lookup', blocked);
  // Match Next's server compilation for its marker package only. This fixture
  // executes real server modules in Node; no business import or assertion is mocked.
  const serverOnlyMarker = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js');
  assert.equal(statSync(serverOnlyMarker).size, 0);
  const resolver = require('node:module') as { _resolveFilename: (...args: unknown[]) => string };
  const originalResolve = resolver._resolveFilename;
  mock.method(resolver, '_resolveFilename', (...args: unknown[]) => args[0] === 'server-only'
    ? serverOnlyMarker : originalResolve.apply(resolver, args));
  try {
    const owner = 'dimension-fixture-owner', channelId = `fixture-${randomUUID()}`, revision = randomUUID();
    const user = await db.user.create({ data: { id: owner, name: 'Dimension fixture', username: owner, email: `${owner}@fixture.invalid`,
      password_hash: 'synthetic-not-a-login', role: 'admin', account_type: 'internal' } }) as SessionUser;
    await db.creditAccount.create({ data: { user_id: owner, balance: 10, frozen_credits: 1 } });
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 37, g: 88, b: 121 } } }).png().toBuffer();
    const originalSha256 = sha(png), allocation = [{ source_type: 'balance', amount: 1 }];
    const active = await db.imageStudioTask.create({ data: { id: 'fresh-mismatch', batch_id: 'fresh-batch', owner_id: owner,
      ordinal: 1, fingerprint: 'fresh-fingerprint', prompt: '', context: 'Fixture', revision: 1, model: 'fixture-model',
      quality: 'max', billing_mode: 'fixed', billing_status: 'channel_unmatched', snapshot_json: JSON.stringify({ requestId: 'fresh-request-original',
        referencePolicy: { primaryIds: [] }, primaryReferenceImages: [], referenceImages: [], imageChannel: { channelId, configRevision: revision } }),
      aspect_ratio: '1:1', output_size: '32x32', reference_ids: '[]', unit_credits: 1, freeze_snapshot: JSON.stringify(allocation),
      status: 'channel_running', lease_token: 'fresh-lease', lease_until: new Date(Date.now() + 120000) } });
    await db.creditLedger.create({ data: { user_id: owner, type: 'task_freeze', amount: -1, balance_before: 10, balance_after: 10,
      frozen_before: 0, frozen_after: 1, related_task_id: active.id, idempotency_key: `image-studio:freeze:${active.id}`,
      reason: 'Fixture freeze', metadata_json: JSON.stringify({ allocations: allocation }) } });
    const delivery = await import('../src/lib/image-studio/delivery');
    await delivery.beginStudioRequest(active); await delivery.setStudioUnsentRequestState(active, 'attempted');
    await delivery.recordStudioResponse(active, new Response('', { status: 202, headers: { 'x-request-id': 'fixture-upstream-request' } }));
    await delivery.createStudioAsyncReceipt(active, { taskId: 'fixture-provider-task', pollAfterMs: 2000 });
    const { finishRejectedStudioDimensions, retainSettledStudioDimensionMismatch, readRetainedStudioDimensionOriginal } = await import('../src/lib/image-studio/dimension-rejection');
    const mismatchModule = await import('../src/lib/image-studio/dimension-mismatch');
    assert.equal(await finishRejectedStudioDimensions(active, png), true);
    const finished = await db.imageStudioTask.findUniqueOrThrow({ where: { id: active.id } });
    assert.equal(finished.status, 'failed'); assert.ok(finished.asset_id); assert.equal(finished.actual_credits, 0);
    assert.ok(finished.billing_settled_at && finished.error?.includes('可继续使用'));
    assert.ok(mismatchModule.studioTaskHasViewableDimensionMismatch(finished));
    const asset = await db.asset.findUniqueOrThrow({ where: { id: finished.asset_id! } });
    assert.equal(asset.hash, originalSha256); assert.equal(asset.width, 16); assert.equal(asset.height, 16);
    assert.equal(JSON.parse(asset.metadata_json || '{}').deliveryDisposition, 'generated_dimensions_mismatch');
    assert.ok(existsSync(path.join(directory, 'public', asset.original_url)) && existsSync(path.join(directory, 'public', asset.thumbnail_url!)));
    assert.ok(existsSync(path.join(directory, 'storage/studio-billing', active.id, `rejected-dimensions-${originalSha256}.png`)));
    assert.equal(await db.creditLedger.count({ where: { related_task_id: active.id } }), 2);
    assert.deepEqual(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } }).then(row => [row.balance, row.frozen_credits]), [10, 0]);
    checks.push('fresh_mismatch_retains_viewable_asset_refunds_once');

    const seed = async (id: string, native = false) => {
      const before = await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } });
      await db.creditAccount.update({ where: { user_id: owner }, data: { frozen_credits: { increment: 1 } } });
      const task = await db.imageStudioTask.create({ data: { ...active, id, batch_id: `${id}-batch`, fingerprint: `${id}-fingerprint`,
        snapshot_json: JSON.stringify({ requestId: `${id}-request`, referencePolicy: { primaryIds: [] }, primaryReferenceImages: [], referenceImages: [],
          ...(native ? {} : { imageChannel: { channelId, configRevision: revision } }) }),
        status: native ? 'running' : 'channel_running', lease_token: `${id}-lease`, lease_until: new Date(Date.now() + 120000) } });
      await db.creditLedger.create({ data: { user_id: owner, type: 'task_freeze', amount: -1,
        balance_before: before.balance, balance_after: before.balance, frozen_before: before.frozen_credits, frozen_after: before.frozen_credits + 1,
        related_task_id: task.id, idempotency_key: `image-studio:freeze:${task.id}`, reason: 'Fixture freeze', metadata_json: JSON.stringify({ allocations: allocation }) } });
      await delivery.beginStudioRequest(task);
      if (!native) await delivery.setStudioUnsentRequestState(task, 'attempted');
      await delivery.recordStudioResponse(task, new Response('', { status: 202, headers: { 'x-request-id': `${id}-upstream` } }));
      if (!native) await delivery.createStudioAsyncReceipt(task, { taskId: `${id}-provider`, pollAfterMs: 2000 });
      return task;
    };
    const native = await seed('native-mismatch', true);
    assert.equal(await finishRejectedStudioDimensions(native, png), true);
    const nativeFinished = await db.imageStudioTask.findUniqueOrThrow({ where: { id: native.id } });
    assert.equal(nativeFinished.status, 'uncertain'); assert.ok(mismatchModule.studioTaskHasViewableOutput(nativeFinished));
    assert.equal(nativeFinished.actual_credits, 0); assert.equal(await db.creditLedger.count({ where: { related_task_id: native.id } }), 2);
    checks.push('native_mismatch_preserves_original_uncertain_refund_policy');

    const late = await seed('late-mismatch');
    const recovery = await import('../src/lib/image-studio/async-recovery');
    const receipt = await delivery.readStudioAsyncReceipt(late); assert.ok(receipt);
    assert.equal(await recovery.releaseStudioAsyncSlot(late, receipt, 'provider_unconfirmed', 'uncertain'), true);
    const recoveryKey = `studio_async_recovery_v1:${late.id}`;
    const row = await db.platformSetting.findUniqueOrThrow({ where: { key: recoveryKey } });
    await db.platformSetting.update({ where: { key: recoveryKey }, data: { value_json: JSON.stringify({ ...JSON.parse(row.value_json), nextCheckAt: Date.now() - 1 }) } });
    const claimed = await recovery.claimStudioAsyncRecovery(); assert.equal(claimed?.task.id, late.id);
    const lateAccount = JSON.stringify(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } }));
    assert.equal(await finishRejectedStudioDimensions(claimed!.task, png), true);
    const lateFinished = await db.imageStudioTask.findUniqueOrThrow({ where: { id: late.id } });
    assert.equal(lateFinished.status, 'uncertain'); assert.ok(mismatchModule.studioTaskHasViewableOutput(lateFinished));
    assert.equal(lateFinished.actual_credits, null); assert.equal(lateFinished.billing_settled_at, null);
    assert.equal(await db.creditLedger.count({ where: { related_task_id: late.id } }), 1);
    assert.equal(JSON.stringify(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })), lateAccount);
    assert.equal(JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: recoveryKey } })).value_json).state, 'complete');
    assert.equal(await recovery.claimStudioAsyncRecovery(), null);
    checks.push('late_mismatch_retains_image_without_billing_decision_or_repeat_query');

    const interrupted = await seed('publication-interrupted');
    const realRename = fs.rename.bind(fs);
    const injected = mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (String(to).includes(`${path.sep}public${path.sep}`)) throw Error('synthetic_publication_failure');
      return realRename(from, to);
    });
    await assert.rejects(finishRejectedStudioDimensions(interrupted, png), /synthetic_publication_failure/);
    injected.mock.restore();
    assert.deepEqual(await readRetainedStudioDimensionOriginal(interrupted), png);
    assert.equal(await db.creditLedger.count({ where: { related_task_id: interrupted.id } }), 1);
    await db.imageStudioTask.update({ where: { id: interrupted.id }, data: { lease_until: new Date(Date.now() - 1000) } });
    const worker = await import('../src/lib/image-studio/worker');
    await worker.recoverStudioTasks();
    assert.ok(mismatchModule.studioTaskHasViewableOutput(await db.imageStudioTask.findUniqueOrThrow({ where: { id: interrupted.id } })));
    assert.equal(await db.creditLedger.count({ where: { related_task_id: interrupted.id } }), 2);
    checks.push('publication_failure_resumes_private_original_without_provider');

    const jpeg = await sharp(png).resize(32, 32).jpeg().toBuffer();
    const wrongFormat = await seed('format-mismatch');
    const formatAccountBefore = JSON.stringify(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } }));
    assert.equal(await finishRejectedStudioDimensions(wrongFormat, jpeg), true);
    const formatFinished = await db.imageStudioTask.findUniqueOrThrow({ where: { id: wrongFormat.id } });
    assert.equal(formatFinished.status, 'uncertain'); assert.equal(formatFinished.actual_credits, null);
    assert.equal(formatFinished.billing_settled_at, null); assert.ok(mismatchModule.studioTaskHasViewableOutput(formatFinished));
    assert.equal(JSON.stringify(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })), formatAccountBefore);
    assert.equal(await db.creditLedger.count({ where: { related_task_id: wrongFormat.id } }), 1);
    const jpegAsset = await db.asset.findUniqueOrThrow({ where: { id: formatFinished.asset_id! } });
    assert.equal(jpegAsset.mime_type, 'image/jpeg'); assert.ok(jpegAsset.original_url.endsWith('.jpg') && jpegAsset.file_name.endsWith('.jpg'));
    assert.deepEqual(readFileSync(path.join(directory, 'public', jpegAsset.original_url)), jpeg);
    assert.equal(jpegAsset.hash, sha(jpeg));
    const { mediaPreviewResponse } = await import('../src/lib/media/preview-response');
    const jpegDownload = await mediaPreviewResponse(new Request('http://fixture.invalid/file'), jpegAsset.original_url, jpegAsset.mime_type);
    assert.equal(jpegDownload.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await jpegDownload.arrayBuffer()), jpeg);
    const { authorizedImageResponse } = await import('../src/lib/media/authorized-image-response');
    const jpegPreview = await authorizedImageResponse(new Request('http://fixture.invalid/file'), jpegAsset.original_url, 'preview', jpegAsset.mime_type);
    assert.equal(jpegPreview.headers.get('content-type'), 'image/webp'); assert.ok((await jpegPreview.arrayBuffer()).byteLength > 0);
    assert.deepEqual(await readRetainedStudioDimensionOriginal(wrongFormat), jpeg);
    const nativeFormat = await seed('native-format-mismatch', true);
    assert.equal(await finishRejectedStudioDimensions(nativeFormat, jpeg), true);
    const nativeFormatFinished = await db.imageStudioTask.findUniqueOrThrow({ where: { id: nativeFormat.id } });
    assert.ok(mismatchModule.studioTaskHasViewableOutput(nativeFormatFinished)); assert.equal(nativeFormatFinished.actual_credits, 0);
    assert.equal(await db.creditLedger.count({ where: { related_task_id: nativeFormat.id } }), 2);
    const lateFormat = await seed('late-format-mismatch');
    const lateFormatReceipt = await delivery.readStudioAsyncReceipt(lateFormat); assert.ok(lateFormatReceipt);
    assert.equal(await recovery.releaseStudioAsyncSlot(lateFormat, lateFormatReceipt, 'provider_unconfirmed', 'uncertain'), true);
    const formatRecoveryKey = `studio_async_recovery_v1:${lateFormat.id}`;
    const formatRecovery = await db.platformSetting.findUniqueOrThrow({ where: { key: formatRecoveryKey } });
    await db.platformSetting.update({ where: { key: formatRecoveryKey }, data: { value_json: JSON.stringify({ ...JSON.parse(formatRecovery.value_json), nextCheckAt: Date.now() - 1 }) } });
    const formatClaim = await recovery.claimStudioAsyncRecovery(); assert.equal(formatClaim?.task.id, lateFormat.id);
    const lateFormatAccount = JSON.stringify(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } }));
    assert.equal(await finishRejectedStudioDimensions(formatClaim!.task, jpeg), true);
    const lateFormatFinished = await db.imageStudioTask.findUniqueOrThrow({ where: { id: lateFormat.id } });
    assert.ok(mismatchModule.studioTaskHasViewableOutput(lateFormatFinished)); assert.equal(lateFormatFinished.actual_credits, null);
    assert.equal(JSON.stringify(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })), lateFormatAccount);
    assert.equal(await db.creditLedger.count({ where: { related_task_id: lateFormat.id } }), 1);
    assert.equal(await recovery.claimStudioAsyncRecovery(), null);
    checks.push('decoded_format_mismatch_keeps_original_mime_bytes_and_original_billing_policy');

    const settledId = 'settled-mismatch', settledUsage = { studioDelivery: { code: 'generated_dimensions_mismatch',
      originalSha256, originalBytes: png.length, validation: { originalFormat: 'png', storedFormat: 'png', width: 16, height: 16, requestedSize: '32x32' } } };
    const settled = await db.imageStudioTask.create({ data: { id: settledId, batch_id: 'settled-batch', owner_id: owner, ordinal: 1,
      fingerprint: 'settled-fingerprint', prompt: '', context: 'Fixture', revision: 1, model: 'fixture-model', quality: 'max',
      billing_mode: 'fixed', billing_status: 'channel_provider_loss', aspect_ratio: '1:1', output_size: '32x32', reference_ids: '[]',
      unit_credits: 1, freeze_snapshot: JSON.stringify(allocation), status: 'failed', actual_credits: 0, billing_settled_at: new Date(),
      finished_at: new Date(), deleted_at: new Date('2026-10-17T12:00:00.123Z'), error: 'Old hidden mismatch', usage_json: JSON.stringify(settledUsage) } });
    for (const [type, amount, before, after, frozenBefore, frozenAfter, key] of [
      ['task_freeze', -1, 10, 10, 0, 1, `image-studio:freeze:${settledId}`],
      ['task_failed_refund', 1, 10, 10, 1, 0, `image-studio:settle:${settledId}`],
    ] as const) await db.creditLedger.create({ data: { user_id: owner, type, amount, balance_before: before, balance_after: after,
      frozen_before: frozenBefore, frozen_after: frozenAfter, related_task_id: settledId, idempotency_key: key, reason: 'Fixture history',
      metadata_json: JSON.stringify({ allocations: allocation }) } });
    const retainedDir = path.join(directory, 'storage/studio-billing', settledId); mkdirSync(retainedDir, { recursive: true, mode: 0o700 });
    const retainedFile = path.join(retainedDir, `rejected-dimensions-${originalSha256}.png`); writeFileSync(retainedFile, png, { mode: 0o600 });
    const accountBefore = JSON.stringify(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } }));
    const ledgerBefore = JSON.stringify(await db.creditLedger.findMany({ where: { related_task_id: settled.id }, orderBy: { id: 'asc' } }));
    await assert.rejects(retainSettledStudioDimensionMismatch(settled.id, originalSha256,
      { restoreExpectedDeletedAtMs: settled.deleted_at!.getTime() + 1 }), /deleted_at_changed/);
    assert.equal((await db.imageStudioTask.findUniqueOrThrow({ where: { id: settled.id } })).asset_id, null);
    const repaired = await retainSettledStudioDimensionMismatch(settled.id, originalSha256);
    const repairedTask = await db.imageStudioTask.findUniqueOrThrow({ where: { id: settled.id } });
    assert.equal(repairedTask.status, 'failed'); assert.equal(repairedTask.asset_id, repaired.assetId);
    assert.ok(mismatchModule.studioTaskHasViewableDimensionMismatch(repairedTask));
    assert.deepEqual({ ...repairedTask, asset_id: null, updated_at: settled.updated_at }, settled);
    assert.equal(await db.creditLedger.count({ where: { related_task_id: settled.id } }), 2);
    assert.equal(JSON.stringify(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })), accountBefore);
    assert.equal((await retainSettledStudioDimensionMismatch(settled.id, originalSha256)).replayed, true);
    await retainSettledStudioDimensionMismatch(settled.id, originalSha256, { restoreExpectedDeletedAtMs: settled.deleted_at!.getTime() });
    const restored = await db.imageStudioTask.findUniqueOrThrow({ where: { id: settled.id } });
    assert.equal(restored.deleted_at, null); assert.equal(restored.asset_id, repaired.assetId);
    assert.deepEqual({ ...restored, asset_id: null, deleted_at: settled.deleted_at, updated_at: settled.updated_at }, settled);
    assert.equal(JSON.stringify(await db.creditLedger.findMany({ where: { related_task_id: settled.id }, orderBy: { id: 'asc' } })), ledgerBefore);
    assert.equal(JSON.stringify(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })), accountBefore);
    checks.push('settled_backfill_idempotent_hidden_by_default_exact_visibility_cas');

    const presetId = randomUUID(), moduleId = randomUUID();
    await db.imageStudioPreset.create({ data: { id: presetId, owner_id: owner, scope: 'admin', is_shared: true, name: 'Fixture preset', model: 'fixture-model' } });
    await db.imageStudioModule.create({ data: { id: moduleId, owner_id: owner, name: 'Fixture module', source_preset_id: presetId } });
    await db.imageStudioTask.update({ where: { id: active.id }, data: { module_id: moduleId, source_preset_id: presetId } });
    await db.imageStudioTask.update({ where: { id: wrongFormat.id }, data: { module_id: moduleId, source_preset_id: presetId } });
    const { getStudioTaskInputMain } = await import('../src/lib/image-studio/input-main');
    assert.equal((await getStudioTaskInputMain(user, active.id)).state, 'none');
    assert.equal((await getStudioTaskInputMain(user, wrongFormat.id)).state, 'none');
    const { resolveContent } = await import('../src/lib/content-reactions/content');
    const content = await resolveContent(user, `asset:${asset.id}`);
    assert.equal(content?.summary.reuse?.assetId, asset.id); assert.ok(content?.summary.downloadUrl);
    const jpegContent = await resolveContent(user, `asset:${jpegAsset.id}`);
    assert.equal(jpegContent?.summary.reuse?.assetId, jpegAsset.id); assert.ok(jpegContent?.summary.downloadUrl);
    const { mutateStudioPin, readableStudioPins } = await import('../src/lib/image-studio/result-pins');
    await mutateStudioPin(user, { viewerId: owner, moduleId, taskId: active.id, assetId: asset.id, active: true, expectedRevision: 0, requestId: randomUUID() });
    assert.equal((await readableStudioPins(user, presetId))?.pins[0]?.asset.id, asset.id);
    await mutateStudioPin(user, { viewerId: owner, moduleId, taskId: wrongFormat.id, assetId: jpegAsset.id, active: true, expectedRevision: 1, requestId: randomUUID() });
    const { setReaction } = await import('../src/lib/content-reactions/service');
    for (const likedAsset of [asset, jpegAsset]) {
      const reaction = await setReaction(user, { viewerId: owner, key: `asset:${likedAsset.id}`, action: 'like', active: true,
        expectedVersion: 0, requestId: randomUUID() });
      assert.equal(reaction.state.liked, true); assert.equal(reaction.state.available, true);
    }
    const { listStudioResultFeed } = await import('../src/lib/image-studio/result-feed');
    assert.ok((await listStudioResultFeed(user, moduleId, undefined, true)).tasks.some(task => task.id === active.id && task.asset?.id === asset.id));
    assert.ok((await listStudioResultFeed(user, moduleId, undefined, true)).tasks.some(task => task.id === wrongFormat.id && task.asset?.id === jpegAsset.id));
    const { listStudioTasks } = await import('../src/lib/image-studio/tasks');
    assert.ok((await listStudioTasks(owner, undefined, moduleId, false, undefined, undefined, true)).tasks.some(task => task.id === active.id && task.asset?.id === asset.id));
    assert.ok((await listStudioTasks(owner, undefined, moduleId, false, undefined, undefined, true)).tasks.some(task => task.id === wrongFormat.id && task.asset?.id === jpegAsset.id));
    await assert.rejects(getStudioTaskInputMain({ ...user, id: 'different-owner' }, active.id));
    checks.push('normal_actions_follow_owner_source_permissions_not_size_status');
    assert.equal(mismatchModule.studioTaskHasViewableDimensionMismatch({ status: 'failed', asset_id: 'asset', usage_json: '{}' }), false);
    assert.equal(mismatchModule.studioTaskHasViewableOutput({ status: 'uncertain', asset_id: 'asset', usage_json: '{}' }), false);
    assert.equal(mismatchModule.studioOutputFormat('__proto__'), null);
    await assert.rejects(finishRejectedStudioDimensions(await seed('corrupt-output'), png.subarray(0, 50)));
    assert.equal((await db.imageStudioTask.findUniqueOrThrow({ where: { id: 'corrupt-output' } })).asset_id, null);
    checks.push('plain_failure_corrupt_or_unproven_output_stays_unavailable');
    assert.equal(forbiddenCalls, 0); completed = true;
  } finally {
    mock.restoreAll(); await db.$disconnect(); process.chdir(root);
    for (const [file, digest] of Object.entries(sourceSha256)) assert.equal(sha(readFileSync(path.join(root, file))), digest);
    const receipt = path.join(directory, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ schema: 'image-dimension-mismatch-engineering.v1', synthetic: true, runId, startedAt,
      finishedAt: new Date().toISOString(), completed, checks, fixtureSha256, sourceSha256, forbiddenCalls,
      productionWrites: 0, paidRequests: 0, browserRuns: 0, serverOnlyMarker,
      serverOnlyMarkerSha256: sha(readFileSync(serverOnlyMarker)) }, null, 2), { mode: 0o600, flag: 'wx' });
    assert.equal(lstatSync(receipt).mode & 0o777, 0o600); process.umask(previousUmask);
    if (completed) console.log(`Image dimension mismatch engineering receipt: ${receipt}`);
  }
}

void main().then(() => { process.exitCode = 0; }).catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => clearTimeout(deadline));
