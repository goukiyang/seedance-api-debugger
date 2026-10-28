/** Isolated database / real HTTP-handler engineering checks. No providers or GPU. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from '../src/lib/prisma';
import { LocalImageService } from '../src/lib/local-images/service';
import { assertIsolatedEnvironment, isolationRoot, newCredential, tokenHash, publicProfile, sha256, type Profile } from '../src/lib/local-images/core';
import { localImageHandler } from '../src/lib/local-images/http';
import { receiveOutput, readOutput } from '../src/lib/local-images/files';

async function main() {
  assertIsolatedEnvironment();
  await prisma.$queryRawUnsafe('PRAGMA synchronous = FULL');
  const run = randomUUID(); const user = `test-${run}`; const machine = `machine-${run}`;
  const callerId = `caller-${run}`; const workerId = `worker-${run}`;
  const caller = newCredential('caller', callerId); const worker = newCredential('worker', workerId);
  const profile = { capability: 'text-to-image', executionProfileId: 'protocol-fixture', modelId: 'protocol-fixture', modelVersion: '1',
    workflowId: 'fixture', workflowVersion: '1', workflowSha256: 'a'.repeat(64), environmentRevision: 'fixture', parameterSchemaVersion: '1',
    parameterSchema: { fields: { prompt: { type: 'string', required: true, minLength: 1, maxLength: 4000 },
      width: { type: 'integer', default: 8 }, height: { type: 'integer', default: 8 } }, allowedDimensions: [[8, 8]], maxPixels: 64 } } as Profile;
  const service = new LocalImageService(prisma, [profile], ['protocol-fixture']);
  await prisma.user.create({ data: { id: user, name: 'COMFY03 isolated test', username: user, email: user + '@invalid.test', password_hash: '!disabled' } });
  for (const [id, kind, subject, token] of [[callerId, 'caller', user, caller], [workerId, 'worker', machine, worker]]) {
    await prisma.localImageCredential.create({ data: { id, kind, subject_id: subject, token_hash: tokenHash(token),
      profile_ids_json: JSON.stringify(['protocol-fixture']), expires_at: new Date(Date.now() + 3600000) } });
  }
  let count = 0;
  const check = async (name: string, runCheck: () => Promise<unknown>) => { await runCheck(); count++; console.log('PASS ' + name); };
  const post = (route: string, input: Record<string, unknown>, key = randomUUID()) => service.write(worker, key, route, { ...input, operationId: key });
  const create = (requestId = randomUUID(), prompt = 'fixture') => service.create(caller, { requestId, executionProfileId: 'protocol-fixture', params: { prompt } });
  const session = randomUUID(); const caps = [publicProfile(profile)];
  const hello = (sessionId: string) => post('hello', { workerId: machine, workerSessionId: sessionId, protocolVersion: 'comfy03/0.1', concurrency: 1, capabilities: caps, resources: {}, unresolved: [], pendingClaimRequestId: null });
  await check('offline admission rejects new task', () => assert.rejects(() => create(), /WORKER_OFFLINE/));
  await hello(session);
  await check('machine key cannot call caller routes', () => assert.rejects(() => service.catalog(worker), /INVALID_TOKEN/));
  await check('caller key cannot call machine routes', () => assert.rejects(() => service.auth(caller, 'worker'), /INVALID_TOKEN/));
  await check('catalog reflects actual online profile', async () => assert.equal((await service.catalog(caller)).models[0].available, true));
  await check('unknown parameters rejected', () => assert.rejects(() => service.create(caller, { requestId: randomUUID(), executionProfileId: 'protocol-fixture', params: { prompt: 'a', workflow: {} } }), /UNKNOWN_FIELD/));
  await check('production gate remains closed', async () => {
    const previous = process.env.COMFY03_ENVIRONMENT; process.env.COMFY03_ENVIRONMENT = 'production';
    try { const response = await localImageHandler(new Request('http://localhost/api/local-images/models'), ['models'], 'caller'); assert.equal(response.status, 503); }
    finally { process.env.COMFY03_ENVIRONMENT = previous; }
  });
  const key = randomUUID(); const created = await create(key);
  await check('same request returns original task', async () => assert.equal((await create(key)).taskId, created.taskId));
  await check('unknown submit is recoverable with read-only request lookup', async () => assert.equal((await service.findRequest(caller, key)).taskId, created.taskId));
  await check('changed body with same request rejected', () => assert.rejects(() => create(key, 'changed'), /IDEMPOTENCY_CONFLICT/));
  await check('test tasks reuse ImageStudioTask without ledger', async () => {
    const task = await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: created.taskId } });
    assert.equal(task.execution_backend, 'local'); assert.equal(task.billing_status, 'not_applicable_test');
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: task.id } }), 0);
  });
  await check('second owner cannot read task or request', async () => {
    const other = 'other-' + run; const otherKeyId = randomUUID(); const otherToken = newCredential('caller', otherKeyId);
    await prisma.user.create({ data: { id: other, name: 'Other fixture owner', username: other, email: other + '@invalid.test', password_hash: '!disabled' } });
    await prisma.localImageCredential.create({ data: { id: otherKeyId, kind: 'caller', subject_id: other, token_hash: tokenHash(otherToken),
      profile_ids_json: JSON.stringify(['protocol-fixture']), expires_at: new Date(Date.now() + 60000) } });
    await assert.rejects(() => service.get(otherToken, created.taskId), /TASK_NOT_FOUND/);
    await assert.rejects(() => service.findRequest(otherToken, key), /REQUEST_NOT_FOUND/);
    await prisma.localImageCredential.update({ where: { id: otherKeyId }, data: { revoked_at: new Date() } });
  });
  await check('expired key denied', async () => {
    const expiredId = randomUUID(); const expired = newCredential('caller', expiredId);
    await prisma.localImageCredential.create({ data: { id: expiredId, kind: 'caller', subject_id: user, token_hash: tokenHash(expired),
      profile_ids_json: JSON.stringify(['protocol-fixture']), expires_at: new Date(0) } });
    await assert.rejects(() => service.catalog(expired), /INVALID_TOKEN/);
  });
  await check('wrong secret cannot authenticate with known key id', () => assert.rejects(() => service.auth(newCredential('caller', callerId), 'caller'), /INVALID_TOKEN/));
  await check('project cannot be supplied outside credential scope', () => assert.rejects(() => service.create(caller, {
    requestId: randomUUID(), executionProfileId: 'protocol-fixture', params: { prompt: 'x' }, projectId: 'other-project' }), /PROJECT_SCOPE_MISMATCH/));
  const claimId = randomUUID(); const claimOp = randomUUID();
  const claimBody = { workerSessionId: session, claimRequestId: claimId, capabilities: caps };
  const claimed = await post('claim', claimBody, claimOp); const a = claimed.assignment;
  const bind = { workerSessionId: session, attemptId: a.attemptId, fencingEpoch: a.fencingEpoch };
  const taskRoute = `tasks/${created.taskId}/`;
  await check('lost claim response replays durable assignment', async () => assert.deepEqual(await post('claim', claimBody, claimOp), claimed));
  await check('occupied machine cannot get second allocation', () => assert.rejects(() => post('claim', { ...claimBody, claimRequestId: randomUUID() }), /WORKER_NOT_READY|WORKER_OCCUPIED/));
  await check('started task cannot be cancelled as queued', () => assert.rejects(() => service.cancel(caller, created.taskId), /RUNNING_CANCEL_UNSUPPORTED/));
  await post(taskRoute + 'start', { ...bind, workflowSha256: profile.workflowSha256 });
  await check('start permission only granted once', () => assert.rejects(() => post(taskRoute + 'start', { ...bind, workflowSha256: profile.workflowSha256 }), /START_NOT_GRANTED/));
  const promptId = randomUUID();
  await post(taskRoute + 'events', { ...bind, sequence: 1, eventId: randomUUID(), stage: 'running', promptId });
  await check('old event sequence rejected', () => assert.rejects(() => post(taskRoute + 'events', { ...bind, sequence: 1, eventId: randomUUID(), stage: 'running', promptId }), /SEQUENCE_CONFLICT/));
  const nextSession = randomUUID(); await hello(nextSession);
  await check('new hello fences old writer', () => assert.rejects(() => post(taskRoute + 'heartbeat', { ...bind, sequence: 1, stage: 'running' }), /SESSION_FENCED/));
  const restored = await post(taskRoute + 'reconcile', { ...bind, workerSessionId: nextSession,
    evidence: { attemptId: a.attemptId, phase: 'running', promptId, outputs: [] } });
  assert.equal(restored.action, 'observe'); assert.ok(restored.fencingEpoch > a.fencingEpoch);
  const rebound = { ...bind, workerSessionId: nextSession, fencingEpoch: restored.fencingEpoch };
  await post(taskRoute + 'events', { ...rebound, sequence: 2, eventId: randomUUID(), stage: 'uploading', promptId });
  const raw = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#368bc1' } }).png().toBuffer();
  const uploadRequest = () => new Request('http://localhost/upload', { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array(raw) });
  const outputRoot = path.join(isolationRoot(), 'outputs');
  await check('upload digest mismatch rejected', () => assert.rejects(() => receiveOutput(uploadRequest(), outputRoot, a.attemptId, 'f'.repeat(64), raw.length), /UPLOAD_DIGEST_MISMATCH/));
  const saved = await receiveOutput(uploadRequest(), outputRoot, a.attemptId, sha256(raw), raw.length);
  const uploadOp = randomUUID(); const uploadBody = { ...rebound, sha256: sha256(raw), bytes: raw.length, operationId: uploadOp };
  const uploaded = await service.write(worker, uploadOp, taskRoute + 'outputs/image-1', uploadBody, saved);
  await check('upload replay returns original asset id', async () => assert.deepEqual(await service.write(worker, uploadOp, taskRoute + 'outputs/image-1', uploadBody, saved), uploaded));
  await check('uploaded output not published before completion', () => assert.rejects(() => service.download(caller, created.taskId, 'image-1'), /OUTPUT_NOT_READY/));
  await check('completion requires exact output manifest', () => assert.rejects(() => post(taskRoute + 'complete', { ...rebound, status: 'succeeded', outputs: [] }), /OUTPUT_MANIFEST_MISMATCH/));
  const completionOp = randomUUID(); const completed = await post(taskRoute + 'complete', { ...rebound, status: 'succeeded', outputs: [uploaded] }, completionOp);
  await check('completion replay never creates duplicate asset', async () => {
    assert.deepEqual(await post(taskRoute + 'complete', { ...rebound, status: 'succeeded', outputs: [uploaded] }, completionOp), completed);
    assert.equal(await prisma.asset.count({ where: { id: uploaded.assetId } }), 1);
  });
  await check('persisted receipt survives service reconstruction', async () => {
    const restarted = new LocalImageService(prisma, [profile], ['protocol-fixture']);
    const key = randomUUID();
    const result = await restarted.write(worker, key, taskRoute + 'reconcile', { ...rebound, operationId: key, evidence: { attemptId: a.attemptId } });
    assert.deepEqual(result, { action: 'terminal', receipt: completed });
  });
  await check('download reads and verifies durable original bytes', async () => {
    const output = await service.download(caller, created.taskId, 'image-1');
    assert.equal(sha256(await readOutput(outputRoot, output.file_path, output.delivered_sha256)), output.delivered_sha256);
  });
  await check('HTTP route delivers image using caller Bearer', async () => {
    const response = await localImageHandler(new Request('http://localhost/api/local-images/tasks/' + created.taskId + '/outputs/image-1', { headers: { Authorization: 'Bearer ' + caller } }), ['tasks', created.taskId, 'outputs', 'image-1'], 'caller', service);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), saved.deliveredSha256);
  });
  const cancelled = await create();
  await check('queued cancel is durable and idempotent', async () => {
    assert.equal((await service.cancel(caller, cancelled.taskId)).status, 'cancelled');
    assert.equal((await service.cancel(caller, cancelled.taskId)).status, 'cancelled');
  });
  await check('expired lease remains occupied and cannot start', async () => {
    const created = await create();
    const held = await post('claim', { workerSessionId: nextSession, claimRequestId: randomUUID(), capabilities: caps });
    assert.equal(held.assignment.taskId, created.taskId);
    await prisma.localImageAttempt.update({ where: { id: held.assignment.attemptId }, data: { lease_until: new Date(0) } });
    const b = { workerSessionId: nextSession, attemptId: held.assignment.attemptId, fencingEpoch: held.assignment.fencingEpoch };
    await assert.rejects(() => post(`tasks/${created.taskId}/start`, { ...b, workflowSha256: profile.workflowSha256 }), /LEASE_FENCED/);
    assert.equal((await service.get(caller, created.taskId)).status, 'reconciling');
    const recoverySession = randomUUID(); await hello(recoverySession);
    await assert.rejects(() => post(`tasks/${created.taskId}/reconcile`, { ...b, workerSessionId: recoverySession,
      evidence: { attemptId: held.assignment.attemptId, promptId: randomUUID(), outputs: [] } }), /NO_START_EVIDENCE/);
    const heldResult = await post(`tasks/${created.taskId}/reconcile`, { ...b, workerSessionId: recoverySession,
      evidence: { attemptId: held.assignment.attemptId, journalMissing: true, outputs: [] } });
    assert.equal(heldResult.action, 'hold');
    assert.ok(await prisma.localImageAttempt.findUnique({ where: { active_worker_id: machine } }));
  });
  await check('revoked credential loses download access immediately', async () => {
    await prisma.localImageCredential.update({ where: { id: callerId }, data: { revoked_at: new Date() } });
    await assert.rejects(() => service.download(caller, created.taskId, 'image-1'), /INVALID_TOKEN/);
  });
  await prisma.localImageCredential.update({ where: { id: workerId }, data: { revoked_at: new Date() } });
  const report = { date: new Date().toISOString(), passed: count, scope: 'isolated-sqlite-and-real-http-handlers-fixture-image-no-GPU-no-production', taskId: created.taskId };
  await fs.mkdir('docs/comfy03', { recursive: true });
  await fs.writeFile('docs/comfy03/engineering-check.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'check failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
