import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { mock } from 'node:test';
import sharp from 'sharp';

async function main() {
  const root = process.cwd(), fixture = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'image-private-snapshot-')));
  // Key material stays in a distinct external fixture root, matching the real storage boundary.
  const policyRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'image-private-policy-')));
  for (const key of Object.keys(process.env).filter(key => key.startsWith('PRIVATE_PROMPTS_'))) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${fixture}/isolated.sqlite`, PRIVATE_PROMPTS_FIXTURE_ROOT: policyRoot,
    PRIVATE_PROMPTS_POLICY_FILE: path.join(policyRoot, 'policy.json'), PRIVATE_PROMPTS_MIN_STATE: 'compatible-read',
    PRIVATE_PROMPTS_CONSUMER_ID: 'fixture', PRIVATE_PROMPTS_RUNTIME_REVISION: 'a'.repeat(40) });
  const write = (file: string, value: unknown) => writeFileSync(file, Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
  const ownerId = 'snapshot-fixture-owner', moduleId = 'snapshot-fixture-module';
  const policy = { schema: 'private-prompt-policy.v1', revision: 'snapshot-fixture-policy', state: 'encrypted-write', minimumReader: 1,
    identities: [{ userId: ownerId, tenant: 'fixture-tenant', subject: 'fixture-subject', administrator: true }],
    origins: [{ kind: 'image-module', id: moduleId, ownerId }], authorKinds: [{ ownerId, kinds: ['image-module','image-preset','skill','video-template'] }],
    keys: Object.fromEntries(['body','index','backup'].map(domain => { const file = path.join(policyRoot, `${domain}.key`); write(file, randomBytes(32)); return [domain, { active: domain, files: { [domain]: file } }]; })),
    destinations: [], consumers: ['fixture'], activation: { inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', writerFenceId: 'fixture-fence', attestationFile: path.join(policyRoot, 'consumers.json') },
    migrationVerified: { inventoryId: 'fixture-inventory', restoreId: 'fixture-restore', remainingPlaintext: 0 } };
  write(process.env.PRIVATE_PROMPTS_POLICY_FILE!, policy);
  write(policy.activation.attestationFile, { schema: 'private-prompt-consumers.v1', policyRevision: policy.revision,
    ...Object.fromEntries(['inventoryId','restoreId','writerFenceId'].map(key => [key, policy.activation[key as keyof typeof policy.activation]])),
    consumers: [{ id: 'fixture', reader: 1, permissionContract: 1, sourceRevision: 'a'.repeat(40) }] });
  const schema = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')],
    { cwd: fixture, env: { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PATH: process.env.PATH, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' }, encoding: 'utf8', timeout: 120000 });
  assert.equal(schema.status, 0, schema.stderr?.slice(-800));
  const { PrismaClient } = await import('@prisma/client'); const db = new PrismaClient(); Reflect.set(globalThis, 'prisma', db); Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const originalFetch = globalThis.fetch; let forbiddenCalls = 0;
  const blocked = () => { forbiddenCalls++; throw Error('Fixture external transport forbidden'); };
  globalThis.fetch = blocked; mock.method(http, 'request', blocked); mock.method(http, 'get', blocked); mock.method(https, 'request', blocked); mock.method(https, 'get', blocked);
  const checks: string[] = [];
  try {
    process.chdir(fixture);
    const privateStorage = await import('../src/lib/image-studio/private-storage.server');
    const fields = await import('../src/lib/security/private-prompt-fields.server');
    const rejection = await import('../src/lib/image-studio/dimension-rejection');
    const delivery = await import('../src/lib/image-studio/delivery');
    const recovery = await import('../src/lib/image-studio/async-recovery');
    const mismatch = await import('../src/lib/image-studio/dimension-mismatch');
    await db.user.create({ data: { id: ownerId, name: 'Fixture', username: ownerId, email: `${ownerId}@example.invalid`, password_hash: 'fixture-only', role: 'admin', account_type: 'internal' } });
    await db.creditAccount.create({ data: { user_id: ownerId, balance: 7, frozen_credits: 0 } });
    const accountBefore = await db.creditAccount.findUniqueOrThrow({ where: { user_id: ownerId } });
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 21, g: 53, b: 99, alpha: 0.5 } } }).png().toBuffer();
    const channelId = `fixture-${randomUUID()}`, revision = randomUUID();
    const seed = async (id: string) => {
      const task = await db.imageStudioTask.create({ data: { id, owner_id: ownerId, module_id: moduleId, batch_id: `batch-${id}`, ordinal: 1, fingerprint: `fingerprint-${id}`,
        prompt: 'synthetic private prompt', context: 'synthetic private context', revision: 1, model: 'fixture-model', quality: 'max', aspect_ratio: '1:1', output_size: '32x32', reference_ids: '[]',
        snapshot_json: JSON.stringify({ requestId: `request-${id}`, prompt: 'synthetic snapshot prompt', moduleContext: 'synthetic module context', effectiveContext: 'synthetic effective context',
          imageChannel: { channelId, configRevision: revision }, referencePolicy: { primaryIds: [] }, primaryReferenceImages: [], referenceImages: [] }),
        unit_credits: 0, billing_mode: 'fixed', billing_status: 'channel_unmatched', status: 'channel_running', lease_token: `lease-${id}`, lease_until: new Date(Date.now() + 120000) } });
      const sealed = privateStorage.transformPrivateImageTask(task, true);
      const raw = await db.imageStudioTask.update({ where: { id }, data: { prompt: sealed.prompt, context: sealed.context, snapshot_json: sealed.snapshot_json } });
      const runtime = privateStorage.transformPrivateImageTask(raw, false);
      assert.notEqual(runtime.snapshot_json, raw.snapshot_json); assert.notEqual(runtime.prompt, raw.prompt); assert.equal(fields.privateStoredValue(runtime), raw);
      await delivery.beginStudioRequest(raw); await delivery.setStudioUnsentRequestState(raw, 'attempted');
      await delivery.recordStudioResponse(raw, new Response('', { status: 202, headers: { 'x-request-id': `upstream-${id}` } }));
      const receipt = await delivery.createStudioAsyncReceipt(raw, { taskId: `provider-${id}`, pollAfterMs: 2000 });
      return { raw, runtime, receipt };
    };

    const fresh = await seed('private-fresh-mismatch');
    assert.equal(rejection.studioTaskBeforeHash(fresh.raw), rejection.studioTaskBeforeHash(fresh.runtime));
    assert.equal(await rejection.finishRejectedStudioDimensions(fresh.runtime, png), true);
    const finished = await db.imageStudioTask.findUniqueOrThrow({ where: { id: fresh.raw.id } });
    assert.equal(finished.snapshot_json, fresh.raw.snapshot_json); assert.equal(finished.prompt, fresh.raw.prompt); assert.equal(finished.context, fresh.raw.context);
    assert.ok(mismatch.studioTaskHasViewableOutput(finished)); const asset = await db.asset.findUniqueOrThrow({ where: { id: finished.asset_id! } });
    assert.ok((await fs.readFile(path.join(fixture, 'public', asset.original_url))).equals(png));
    const marker = JSON.parse(await fs.readFile(path.join(fixture, 'storage/studio-billing', fresh.raw.id, 'dimension-retention.json'), 'utf8'));
    const rawIdentity = createHash('sha256').update(JSON.stringify([fresh.raw.id,fresh.raw.owner_id,fresh.raw.batch_id,fresh.raw.fingerprint,fresh.raw.snapshot_json,fresh.raw.output_size,fresh.raw.reference_ids,fresh.raw.billing_contract_json,fresh.raw.freeze_snapshot])).digest('hex');
    assert.equal(marker.identity, rawIdentity); checks.push('encrypted_runtime_publication_uses_unchanged_raw_freeze');

    const changed = await seed('private-freeze-changed');
    const nextSnapshot = JSON.stringify({ ...JSON.parse(changed.raw.snapshot_json!), requestId: 'different-request' });
    await db.imageStudioTask.update({ where: { id: changed.raw.id }, data: { snapshot_json: nextSnapshot } });
    await assert.rejects(rejection.finishRejectedStudioDimensions(changed.runtime, png), /dimension_rejection_publication_scope_lost/);
    assert.equal((await db.imageStudioTask.findUniqueOrThrow({ where: { id: changed.raw.id } })).asset_id, null);
    checks.push('fresh_database_freeze_change_still_rejects');

    const interrupted = await seed('private-publication-interrupted');
    const rename = fs.rename.bind(fs); const injected = mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (String(to).includes(`${path.sep}public${path.sep}`)) throw Error('fixture_publication_failure'); return rename(from, to);
    });
    await assert.rejects(rejection.finishRejectedStudioDimensions(interrupted.runtime, png), /fixture_publication_failure/); injected.mock.restore();
    assert.deepEqual(await rejection.readRetainedStudioDimensionOriginal(interrupted.raw), png);
    assert.deepEqual(await rejection.readRetainedStudioDimensionOriginal(interrupted.runtime), png);
    assert.equal(await rejection.finishRejectedStudioDimensions(interrupted.raw, png), true);
    const resumed = await db.imageStudioTask.findUniqueOrThrow({ where: { id: interrupted.raw.id } }); assert.ok(resumed.asset_id); assert.equal(resumed.snapshot_json, interrupted.raw.snapshot_json);
    checks.push('raw_checkpoint_survives_publication_failure_and_runtime_to_raw_resume');

    const asyncTask = await seed('private-async-recovery');
    assert.equal(await recovery.releaseStudioAsyncSlot(asyncTask.runtime, asyncTask.receipt, 'provider_unconfirmed', 'uncertain'), true);
    const rawUncertain = await db.imageStudioTask.findUniqueOrThrow({ where: { id: asyncTask.raw.id } });
    const rawView = await recovery.readStudioAsyncRecovery(rawUncertain), runtimeView = await recovery.readStudioAsyncRecovery(privateStorage.transformPrivateImageTask(rawUncertain, false));
    assert.ok(rawView); assert.deepEqual(runtimeView, rawView); assert.equal(rawView.maxAttempts, 12);
    assert.equal(rawUncertain.snapshot_json, asyncTask.raw.snapshot_json); assert.equal(rawUncertain.unit_credits, asyncTask.raw.unit_credits); assert.equal(rawUncertain.actual_credits, null);
    const recoveryRow = await db.platformSetting.findUniqueOrThrow({ where: { key: `studio_async_recovery_v1:${asyncTask.raw.id}` } });
    const frozenRecord = JSON.parse(recoveryRow.value_json);
    const expectedBinding = createHash('sha256').update(JSON.stringify([rawUncertain.id,rawUncertain.owner_id,rawUncertain.batch_id,rawUncertain.fingerprint,rawUncertain.model,rawUncertain.prompt,rawUncertain.context,
      rawUncertain.snapshot_json,rawUncertain.reference_ids,rawUncertain.quality,rawUncertain.aspect_ratio,rawUncertain.output_size,rawUncertain.billing_scope,rawUncertain.billing_mode,rawUncertain.billing_contract_json,rawUncertain.unit_credits,rawUncertain.freeze_snapshot,
      frozenRecord.providerTaskId,frozenRecord.acceptedAt,frozenRecord.expiresAt || null,frozenRecord.requestId])).digest('hex');
    assert.equal(frozenRecord.binding, expectedBinding); assert.equal(frozenRecord.attempts, 0); assert.equal(frozenRecord.providerTaskId, asyncTask.receipt.providerTaskId);
    assert.equal(frozenRecord.deadlineAt - frozenRecord.releasedAt, 24 * 60 * 60_000);
    await db.imageStudioTask.update({ where: { id: asyncTask.raw.id }, data: { snapshot_json: JSON.stringify({ ...JSON.parse(rawUncertain.snapshot_json!), requestId: 'changed-after-release' }) } });
    assert.equal(await recovery.readStudioAsyncRecovery(await db.imageStudioTask.findUniqueOrThrow({ where: { id: asyncTask.raw.id } })), null);
    checks.push('existing_raw_async_binding_contract_budget_and_request_preserved');
    assert.deepEqual(await db.creditAccount.findUniqueOrThrow({ where: { user_id: ownerId } }), accountBefore); assert.equal(await db.creditLedger.count(), 0); assert.equal(forbiddenCalls, 0);
    console.log(JSON.stringify({ passed: true, checks, cases: checks.length, realEncryption: true, realSqlite: true, externalRequests: 0, productionWrites: 0, accountAndLedgerPreserved: true }));
  } finally {
    process.chdir(root); globalThis.fetch = originalFetch; mock.restoreAll(); await db.$disconnect();
    const { feedbackPrisma } = await import('../src/lib/feedback/notification'); await feedbackPrisma.$disconnect(); await fs.rm(fixture, { recursive: true, force: true }); await fs.rm(policyRoot, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : 'private snapshot engineering failed'); process.exitCode = 1; });
