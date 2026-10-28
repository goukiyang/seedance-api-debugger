import { randomUUID } from 'node:crypto';
import type { LocalImageAttempt, LocalImageCredential, Prisma, PrismaClient } from '@prisma/client';
import { assertProjectActiveForActorInTransaction } from '@/lib/projects/permissions';
import { recordUsageAttribution } from '@/lib/admin/usage-attribution';
import { reserveImageStudioQueueCapacity } from '@/lib/image-studio/queue-capacity';
import { authenticate } from './auth';
import { canonical, fields, identifier, object, parameters, publicProfile, requireThat, sha256, type Profile } from './core';

const LEASE_MS = 90000;
const ONLINE_MS = 45000;
const terminal = (phase: string) => ['succeeded', 'failed', 'cancelled'].includes(phase);
export type StoredOutput = { rawSha256: string; deliveredSha256: string; path: string; rawBytes: number; bytes: number; width: number; height: number };

export class LocalImageService {
  constructor(readonly db: PrismaClient, readonly profiles: Profile[], readonly enabledProfileIds: string[]) {}
  profile(id: unknown) {
    const profile = this.profiles.find(row => row.executionProfileId === id);
    requireThat(profile && this.enabledProfileIds.includes(profile.executionProfileId), 'PROFILE_NOT_QUALIFIED', 503);
    return profile;
  }
  async transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>) {
    // SQLite serializes these short transactions; no network/decoding runs inside them.
    return this.db.$transaction(run, { maxWait: 10000, timeout: 10000 });
  }
  allowed(credential: LocalImageCredential, profileId: string) {
    requireThat((JSON.parse(credential.profile_ids_json) as string[]).includes(profileId), 'PROFILE_FORBIDDEN', 403);
  }
  async auth(token: string, kind: 'caller' | 'worker') { return authenticate(this.db, token, kind); }
  async catalog(token: string) {
    return this.transaction(async tx => {
      const credential = await authenticate(tx, token, 'caller');
      const machines = await tx.localImageMachine.findMany({ where: { state: { in: ['ready', 'busy'] }, last_seen: { gt: new Date(Date.now() - ONLINE_MS) } } });
      return { environment: 'isolated-test', productionAdmissionEnabled: false, pricing: { enabled: false, unitPrice: null },
        models: this.profiles.filter(p => JSON.parse(credential.profile_ids_json).includes(p.executionProfileId)).map(p => ({
          ...publicProfile(p), parameterSchema: p.parameterSchema,
          available: this.enabledProfileIds.includes(p.executionProfileId) && machines.some(m => this.hasCapability(m.capabilities_json, publicProfile(p))),
        })) };
    });
  }
  hasCapability(raw: string, expected: unknown) { return JSON.parse(raw).some((item: unknown) => canonical(item) === canonical(expected)); }
  async create(token: string, input: unknown) {
    const body = object(input); fields(body, ['requestId', 'executionProfileId', 'params', 'projectId']);
    const requestId = identifier(body.requestId);
    const fingerprint = sha256(canonical(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId'))));
    return this.transaction(async tx => {
      const credential = await authenticate(tx, token, 'caller');
      const owner = credential.subject_id;
      const old = await tx.localImageRequest.findUnique({ where: { owner_id_request_id: { owner_id: owner, request_id: requestId } } });
      if (old) {
        this.allowed(credential, old.profile_id);
        requireThat(credential.project_id === old.project_id, 'PROJECT_SCOPE_MISMATCH', 403);
        requireThat(old.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 409);
        return { taskId: old.task_id, requestId, replayed: true };
      }
      const profile = this.profile(body.executionProfileId); this.allowed(credential, profile.executionProfileId);
      const projectId = body.projectId == null ? null : identifier(body.projectId);
      requireThat(projectId === credential.project_id, 'PROJECT_SCOPE_MISMATCH', 403);
      if (projectId) await assertProjectActiveForActorInTransaction(tx, owner, projectId, 'generate');
      const params = parameters(profile, body.params);
      const online = await tx.localImageMachine.findMany({ where: { state: { in: ['ready', 'busy'] }, last_seen: { gt: new Date(Date.now() - ONLINE_MS) } } });
      requireThat(online.some(m => this.hasCapability(m.capabilities_json, publicProfile(profile))), 'WORKER_OFFLINE', 503);
      await reserveImageStudioQueueCapacity(tx, owner, 1);
      const total = await tx.imageStudioTask.count({ where: { execution_backend: 'local', status: { in: ['local_queued', 'local_leased', 'local_running', 'local_uploading', 'local_reconciling'] } } });
      requireThat(total < 32, 'LOCAL_QUEUE_FULL', 429);
      const id = 'local-' + randomUUID();
      const assignment = { ...publicProfile(profile), params, inputs: [] };
      const task = await tx.imageStudioTask.create({ data: {
        id, batch_id: requestId, owner_id: owner, ordinal: 1, fingerprint, prompt: String(params.prompt), context: '', revision: 1,
        model: profile.modelId, reference_ids: '[]', unit_credits: 0, execution_backend: 'local', status: 'local_queued',
        billing_mode: 'isolated_test', billing_status: 'not_applicable_test',
        billing_contract_json: JSON.stringify({ version: 'comfy03-isolated-v1', pricingEnabled: false, productionPrice: null }),
        snapshot_json: JSON.stringify(assignment), output_size: `${params.width}x${params.height}`,
      } });
      await tx.localImageRequest.create({ data: { id: randomUUID(), owner_id: owner, request_id: requestId, fingerprint,
        task_id: id, profile_id: profile.executionProfileId, project_id: projectId, assignment_json: JSON.stringify(assignment) } });
      await recordUsageAttribution(tx, { sourceKind: 'image_task', sourceId: id, actorUserId: owner, ownerUserId: owner,
        projectId, occurredAt: task.created_at, contextOrigin: 'comfy03-isolated-test' });
      return { taskId: id, requestId, replayed: false };
    });
  }
  async owned(tx: Prisma.TransactionClient, credential: LocalImageCredential, taskId: string) {
    const request = await tx.localImageRequest.findUnique({ where: { task_id: taskId } });
    requireThat(request && request.owner_id === credential.subject_id && request.project_id === credential.project_id, 'TASK_NOT_FOUND', 404);
    this.allowed(credential, request.profile_id);
    if (request.project_id) await assertProjectActiveForActorInTransaction(tx, credential.subject_id, request.project_id, 'generate');
    const task = await tx.imageStudioTask.findFirst({ where: { id: taskId, execution_backend: 'local', deleted_at: null } });
    requireThat(task, 'TASK_NOT_FOUND', 404); return task;
  }
  async get(token: string, taskId: string) {
    return this.transaction(async tx => {
      const credential = await authenticate(tx, token, 'caller');
      const task = await this.owned(tx, credential, identifier(taskId));
      const attempt = await tx.localImageAttempt.findUnique({ where: { task_id: task.id } });
      const status = attempt && !terminal(attempt.phase) && attempt.lease_until <= new Date() ? 'reconciling' : task.status.replace(/^local_/, '');
      return { taskId: task.id, status, error: task.error, pricing: { enabled: false, unitPrice: null },
        outputs: task.status === 'local_succeeded' ? [{ outputId: 'image-1', downloadUrl: `/api/local-images/tasks/${task.id}/outputs/image-1` }] : [] };
    });
  }
  async findRequest(token: string, requestId: string) {
    return this.transaction(async tx => {
      const credential = await authenticate(tx, token, 'caller');
      const request = await tx.localImageRequest.findUnique({ where: { owner_id_request_id: { owner_id: credential.subject_id, request_id: identifier(requestId) } } });
      requireThat(request, 'REQUEST_NOT_FOUND', 404);
      await this.owned(tx, credential, request.task_id);
      return { taskId: request.task_id, requestId: request.request_id };
    });
  }
  async download(token: string, taskId: string, outputId: string) {
    return this.transaction(async tx => {
      const credential = await authenticate(tx, token, 'caller');
      const task = await this.owned(tx, credential, identifier(taskId));
      requireThat(task.status === 'local_succeeded', 'OUTPUT_NOT_READY', 409);
      const attempt = await tx.localImageAttempt.findUnique({ where: { task_id: task.id } });
      requireThat(attempt, 'OUTPUT_NOT_FOUND', 404);
      const output = await tx.localImageOutput.findUnique({ where: { attempt_id_output_id: { attempt_id: attempt.id, output_id: identifier(outputId) } } });
      requireThat(output, 'OUTPUT_NOT_FOUND', 404);
      const asset = await tx.asset.findFirst({ where: { id: output.asset_id, owner_id: task.owner_id, status: 'active' } });
      requireThat(asset, 'OUTPUT_NOT_FOUND', 404); return output;
    });
  }
  async cancel(token: string, taskId: string) {
    return this.transaction(async tx => {
      const credential = await authenticate(tx, token, 'caller');
      const task = await this.owned(tx, credential, identifier(taskId));
      if (task.status === 'local_cancelled') return { taskId, status: 'cancelled' };
      requireThat(task.status === 'local_queued', 'RUNNING_CANCEL_UNSUPPORTED', 409);
      await tx.imageStudioTask.update({ where: { id: taskId }, data: { status: 'local_cancelled', finished_at: new Date() } });
      return { taskId, status: 'cancelled' };
    });
  }
  async currentMachine(tx: Prisma.TransactionClient, credential: LocalImageCredential, session: unknown) {
    const machine = await tx.localImageMachine.findUnique({ where: { id: credential.subject_id } });
    requireThat(machine && machine.session_id === session, 'SESSION_FENCED', 409); return machine;
  }
  async bound(tx: Prisma.TransactionClient, credential: LocalImageCredential, taskId: string, body: Record<string, unknown>, allowExpired = false) {
    await this.currentMachine(tx, credential, body.workerSessionId);
    const attempt = await tx.localImageAttempt.findUnique({ where: { task_id: taskId } });
    requireThat(attempt && attempt.worker_id === credential.subject_id && attempt.id === body.attemptId, 'ATTEMPT_MISMATCH', 409);
    if (!allowExpired) requireThat(attempt.session_id === body.workerSessionId && attempt.epoch === body.fencingEpoch
      && attempt.lease_until > new Date() && !terminal(attempt.phase), 'LEASE_FENCED', 409);
    return attempt;
  }
  async assignment(tx: Prisma.TransactionClient, attempt: LocalImageAttempt) {
    const row = await tx.localImageRequest.findUniqueOrThrow({ where: { task_id: attempt.task_id } });
    return { ...JSON.parse(row.assignment_json), taskId: attempt.task_id, attemptId: attempt.id,
      workerSessionId: attempt.session_id, fencingEpoch: attempt.epoch };
  }
  async write(token: string, operationId: string, route: string, input: unknown, output?: StoredOutput) {
    const body = object(input); identifier(operationId);
    requireThat(body.operationId === operationId, 'OPERATION_ID_MISMATCH');
    const fingerprint = sha256(canonical({ route, body }));
    return this.transaction(async tx => {
      const credential = await authenticate(tx, token, 'worker');
      const scope = credential.subject_id;
      const old = await tx.localImageOperation.findUnique({ where: { scope_operation_id: { scope, operation_id: operationId } } });
      if (old) { requireThat(old.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 409); return JSON.parse(old.receipt_json); }
      let reply: unknown;
      if (route === 'hello') {
        fields(body, ['operationId', 'workerId', 'workerSessionId', 'protocolVersion', 'concurrency', 'capabilities', 'resources', 'unresolved', 'pendingClaimRequestId']);
        requireThat(body.workerId === scope && body.protocolVersion === 'comfy03/0.1' && body.concurrency === 1, 'PROTOCOL_INCOMPATIBLE');
        const session = identifier(body.workerSessionId);
        const caps = this.validateCapabilities(credential, body.capabilities);
        const active = await tx.localImageAttempt.findMany({ where: { active_worker_id: scope } });
        await tx.localImageMachine.upsert({ where: { id: scope }, create: { id: scope, session_id: session, state: active.length ? 'reconciling' : 'ready', capabilities_json: JSON.stringify(caps), last_seen: new Date() },
          update: { session_id: session, sequence: 0, state: active.length ? 'reconciling' : 'ready', capabilities_json: JSON.stringify(caps), last_seen: new Date() } });
        for (const attempt of active) {
          await tx.localImageAttempt.update({ where: { id: attempt.id }, data: { phase: 'reconciling' } });
          await tx.imageStudioTask.update({ where: { id: attempt.task_id }, data: { status: 'local_reconciling' } });
        }
        reply = { protocolVersion: 'comfy03/0.1', workerSessionId: session, previousSessionFenced: true,
          assignments: await Promise.all(active.map(a => this.assignment(tx, a))) };
      } else if (route === 'heartbeat') {
        fields(body, ['operationId', 'workerSessionId', 'sequence', 'state', 'concurrency']);
        const machine = await this.currentMachine(tx, credential, body.workerSessionId);
        requireThat(Number.isSafeInteger(body.sequence) && Number(body.sequence) > machine.sequence && body.concurrency === 1
          && ['ready', 'maintenance'].includes(String(body.state)), 'INVALID_HEARTBEAT', 409);
        const active = await tx.localImageAttempt.findUnique({ where: { active_worker_id: scope } });
        await tx.localImageMachine.update({ where: { id: scope }, data: { sequence: Number(body.sequence), last_seen: new Date(), state: active ? 'busy' : String(body.state) } });
        reply = { accepted: true };
      } else if (route === 'claim') {
        fields(body, ['operationId', 'workerSessionId', 'claimRequestId', 'capabilities']); identifier(body.claimRequestId);
        const machine = await this.currentMachine(tx, credential, body.workerSessionId);
        requireThat(machine.state === 'ready' && machine.last_seen && machine.last_seen.getTime() > Date.now() - ONLINE_MS, 'WORKER_NOT_READY', 409);
        requireThat(!await tx.localImageAttempt.findUnique({ where: { active_worker_id: scope } }), 'WORKER_OCCUPIED', 409);
        const caps = this.validateCapabilities(credential, body.capabilities);
        const tasks = await tx.imageStudioTask.findMany({ where: { execution_backend: 'local', status: 'local_queued' }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 32 });
        let chosen: typeof tasks[number] | undefined;
        for (const task of tasks) {
          const snapshot = object(JSON.parse(task.snapshot_json!));
          const profile = this.profiles.find(p => p.executionProfileId === snapshot.executionProfileId);
          if (!profile || !caps.some(c => canonical(c) === canonical(publicProfile(profile)))) continue;
          const user = await tx.user.findUnique({ where: { id: task.owner_id } });
          if (!user || user.status !== 'active' || user.account_type !== 'internal' || user.role !== 'user' || user.expires_at && user.expires_at <= new Date()) continue;
          chosen = task; break;
        }
        if (!chosen) reply = { empty: true };
        else {
          const attempt = await tx.localImageAttempt.create({ data: { id: randomUUID(), task_id: chosen.id, worker_id: scope,
            active_worker_id: scope, session_id: String(body.workerSessionId), phase: 'leased', lease_until: new Date(Date.now() + LEASE_MS) } });
          await tx.imageStudioTask.update({ where: { id: chosen.id }, data: { status: 'local_leased' } });
          await tx.localImageMachine.update({ where: { id: scope }, data: { state: 'busy', last_seen: new Date() } });
          reply = { assignment: await this.assignment(tx, attempt), leaseRemainingMs: LEASE_MS };
        }
      } else {
        const match = /^tasks\/([A-Za-z0-9_-]+)\/(start|heartbeat|events|reconcile|complete|outputs\/image-1)$/.exec(route);
        requireThat(match, 'ROUTE_NOT_FOUND', 404);
        const [, taskId, action] = match;
        const attempt = await this.bound(tx, credential, taskId, body, action === 'reconcile');
        reply = await this.taskWrite(tx, credential, attempt, action, body, output);
      }
      await tx.localImageOperation.create({ data: { id: randomUUID(), scope, operation_id: operationId, fingerprint, receipt_json: JSON.stringify(reply) } });
      return reply;
    });
  }
  validateCapabilities(credential: LocalImageCredential, value: unknown) {
    requireThat(Array.isArray(value) && value.length <= 16, 'INVALID_CAPABILITIES');
    return value.map(item => {
      const row = object(item); const profile = this.profile(row.executionProfileId); this.allowed(credential, profile.executionProfileId);
      requireThat(canonical(row) === canonical(publicProfile(profile)), 'PROFILE_VERSION_MISMATCH'); return row;
    });
  }
  async taskWrite(tx: Prisma.TransactionClient, credential: LocalImageCredential, a: LocalImageAttempt, action: string, b: Record<string, unknown>, output?: StoredOutput): Promise<unknown> {
    const binding = ['operationId', 'workerSessionId', 'attemptId', 'fencingEpoch'];
    const allowed: Record<string, string[]> = { start: ['workflowSha256'], heartbeat: ['sequence', 'stage'], events: ['eventId', 'sequence', 'stage', 'promptId'],
      reconcile: ['evidence'], complete: ['status', 'outputs', 'failureCode', 'evidence'], 'outputs/image-1': ['sha256', 'bytes'] };
    fields(b, [...binding, ...allowed[action]]);
    if (action === 'reconcile') {
      if (a.terminal_receipt_json) return { action: 'terminal', receipt: JSON.parse(a.terminal_receipt_json) };
      const evidence = object(b.evidence);
      if (evidence.attemptId !== a.id || evidence.journalMissing || typeof evidence.promptId !== 'string') return { action: 'hold' };
      requireThat(!a.prompt_id || a.prompt_id === evidence.promptId, 'PROMPT_ID_MISMATCH', 409);
      requireThat(a.start_granted, 'NO_START_EVIDENCE', 409);
      const epoch = a.epoch + 1;
      await tx.localImageAttempt.update({ where: { id: a.id }, data: { session_id: String(b.workerSessionId), epoch, phase: 'reconciling', prompt_id: identifier(evidence.promptId), lease_until: new Date(Date.now() + LEASE_MS) } });
      return { action: Array.isArray(evidence.outputs) && evidence.outputs.length ? 'upload' : 'observe', attemptId: a.id,
        workerSessionId: b.workerSessionId, fencingEpoch: epoch, leaseRemainingMs: LEASE_MS };
    }
    if (action === 'start') {
      const request = await tx.localImageRequest.findUniqueOrThrow({ where: { task_id: a.task_id } });
      const snapshot = JSON.parse(request.assignment_json);
      requireThat(a.phase === 'leased' && b.workflowSha256 === snapshot.workflowSha256, 'START_NOT_GRANTED', 409);
      if (request.project_id) await assertProjectActiveForActorInTransaction(tx, request.owner_id, request.project_id, 'generate');
      const owner = await tx.user.findUnique({ where: { id: request.owner_id } });
      requireThat(owner && owner.status === 'active' && owner.role === 'user' && owner.account_type === 'internal'
        && (!owner.expires_at || owner.expires_at > new Date()), 'OWNER_INACTIVE', 403);
      await tx.localImageAttempt.update({ where: { id: a.id }, data: { phase: 'started', start_granted: true } });
      await tx.imageStudioTask.update({ where: { id: a.task_id }, data: { status: 'local_running' } });
      return { allowExecution: true, attemptId: a.id, workerSessionId: a.session_id, fencingEpoch: a.epoch, leaseRemainingMs: Math.max(1, a.lease_until.getTime() - Date.now()) };
    }
    if (action === 'heartbeat') {
      requireThat(Number.isSafeInteger(b.sequence) && Number(b.sequence) > a.heartbeat_sequence, 'SEQUENCE_CONFLICT', 409);
      await tx.localImageAttempt.update({ where: { id: a.id }, data: { heartbeat_sequence: Number(b.sequence), lease_until: new Date(Date.now() + LEASE_MS) } });
      await tx.localImageMachine.update({ where: { id: credential.subject_id }, data: { state: 'busy', last_seen: new Date() } });
      return { leaseRemainingMs: LEASE_MS, cancelRequested: false };
    }
    if (action === 'events') {
      identifier(b.eventId); const promptId = identifier(b.promptId);
      requireThat(Number.isSafeInteger(b.sequence) && Number(b.sequence) > a.event_sequence, 'SEQUENCE_CONFLICT', 409);
      requireThat(['running', 'uploading'].includes(String(b.stage)) && a.phase !== 'leased'
        && (a.phase !== 'uploading' || b.stage === 'uploading') && (!a.prompt_id || a.prompt_id === promptId), 'INVALID_STAGE', 409);
      await tx.localImageAttempt.update({ where: { id: a.id }, data: { event_sequence: Number(b.sequence), phase: String(b.stage), prompt_id: promptId } });
      await tx.imageStudioTask.update({ where: { id: a.task_id }, data: { status: 'local_' + b.stage } });
      return { accepted: true };
    }
    if (action === 'outputs/image-1') {
      requireThat(output && a.phase === 'uploading' && b.sha256 === output.rawSha256 && b.bytes === output.rawBytes, 'OUTPUT_INVALID', 422);
      const existing = await tx.localImageOutput.findUnique({ where: { attempt_id_output_id: { attempt_id: a.id, output_id: 'image-1' } } });
      if (existing) {
        requireThat(existing.raw_sha256 === output.rawSha256 && existing.delivered_sha256 === output.deliveredSha256, 'OUTPUT_IMMUTABLE', 409);
        return this.outputReceipt(existing);
      }
      const saved = await tx.localImageOutput.create({ data: { id: randomUUID(), attempt_id: a.id, output_id: 'image-1', asset_id: randomUUID(),
        raw_sha256: output.rawSha256, delivered_sha256: output.deliveredSha256, file_path: output.path,
        bytes: output.bytes, width: output.width, height: output.height } });
      return this.outputReceipt(saved);
    }
    requireThat(action === 'complete' && ['succeeded', 'failed'].includes(String(b.status)) && Array.isArray(b.outputs), 'INVALID_COMPLETION');
    const task = await tx.imageStudioTask.findUniqueOrThrow({ where: { id: a.task_id } });
    let assetId: string | undefined;
    if (b.status === 'succeeded') {
      const saved = await tx.localImageOutput.findUnique({ where: { attempt_id_output_id: { attempt_id: a.id, output_id: 'image-1' } } });
      requireThat(a.phase === 'uploading' && saved && canonical(b.outputs) === canonical([this.outputReceipt(saved)]), 'OUTPUT_MANIFEST_MISMATCH', 409);
      assetId = saved.asset_id;
      await tx.asset.create({ data: { id: assetId, owner_id: task.owner_id, type: 'image', original_url: `/api/local-images/tasks/${task.id}/outputs/image-1`,
        file_name: `${task.id}.png`, mime_type: 'image/png', file_size: saved.bytes, width: saved.width, height: saved.height,
        metadata_json: JSON.stringify({ source: 'comfy03', taskId: task.id, attemptId: a.id, sha256: saved.delivered_sha256, environment: 'isolated-test' }) } });
    } else {
      const evidence = object(b.evidence);
      requireThat(b.outputs.length === 0 && evidence.attemptId === a.id
        && (evidence.phase === 'not_submitted' && !evidence.promptId && !a.prompt_id
          || evidence.phase === 'execution_failed' && typeof evidence.promptId === 'string' && (!a.prompt_id || evidence.promptId === a.prompt_id)), 'FAILURE_NOT_PROVEN', 409);
      identifier(b.failureCode);
    }
    const receipt = { status: b.status, attemptId: a.id, receiptId: randomUUID() };
    await tx.imageStudioTask.update({ where: { id: task.id }, data: { status: 'local_' + b.status, asset_id: assetId,
      error: b.status === 'failed' ? String(b.failureCode) : null, finished_at: new Date() } });
    await tx.localImageAttempt.update({ where: { id: a.id }, data: { phase: String(b.status), active_worker_id: null, terminal_receipt_json: JSON.stringify(receipt) } });
    await tx.localImageMachine.update({ where: { id: a.worker_id }, data: { state: b.status === 'failed' ? 'maintenance' : 'ready', last_seen: new Date() } });
    return receipt;
  }
  outputReceipt(row: { output_id: string; asset_id: string; raw_sha256: string; delivered_sha256: string }) {
    return { outputId: row.output_id, assetId: row.asset_id, rawSha256: row.raw_sha256, deliveredSha256: row.delivered_sha256 };
  }
}
