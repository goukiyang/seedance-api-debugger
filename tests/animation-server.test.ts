import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import type { SessionUser } from '../src/lib/auth/session';
import type { AnimationSequence } from '../src/lib/animation/types';

const projectRoot = process.cwd();
let sandbox = '';
let prisma: typeof import('../src/lib/prisma').prisma;
let requireAnimationDocument: typeof import('../src/lib/animation/access').requireAnimationDocument;
let canCurrentActorRunAnimationJob: typeof import('../src/lib/animation/access').canCurrentActorRunAnimationJob;
let getIdempotentResponse: typeof import('../src/lib/animation/repository').getIdempotentResponse;
let animationRequestHash: typeof import('../src/lib/animation/repository').animationRequestHash;
let createImportedAnimationDocument: typeof import('../src/lib/animation/repository').createImportedAnimationDocument;
let createAnimationJob: typeof import('../src/lib/animation/repository').createAnimationJob;
let registerAnimationCandidateFileInTransaction: typeof import('../src/lib/animation/repository').registerAnimationCandidateFileInTransaction;
let reconcileAnimationUploadManifest: typeof import('../src/lib/animation/repository').reconcileAnimationUploadManifest;
let cancelAnimationDocumentJobs: typeof import('../src/lib/animation/repository').cancelAnimationDocumentJobs;
let patchAnimationDocument: typeof import('../src/lib/animation/repository').patchAnimationDocument;
let preserveSequenceInvariants: typeof import('../src/lib/animation/repository').preserveSequenceInvariants;
let matchesAnimationJobAttempt: typeof import('../src/lib/animation/jobs').matchesAnimationJobAttempt;
let publishAnimationBlob: typeof import('../src/lib/animation/storage').publishAnimationBlob;
let hasAnimationStorageCapacity: typeof import('../src/lib/animation/storage').hasAnimationStorageCapacity;
let animationImportReservedBytes: typeof import('../src/lib/animation/storage').ANIMATION_IMPORT_RESERVED_BYTES;
let hashFile: typeof import('../src/lib/animation/storage').hashFile;
let writeAnimationReconcileManifest: typeof import('../src/lib/animation/storage').writeAnimationReconcileManifest;
let resolveAnimationBlob: typeof import('../src/lib/animation/storage').resolveAnimationBlob;
let exportAnimationBundle: typeof import('../src/lib/animation/media').exportAnimationBundle;
let handleAnimationImportRequest: typeof import('../src/lib/animation/request-handlers').handleAnimationImportRequest;
let serveAnimationFileRequest: typeof import('../src/lib/animation/request-handlers').serveAnimationFileRequest;
let serveAnimationExportRequest: typeof import('../src/lib/animation/request-handlers').serveAnimationExportRequest;

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'animation-server-test-'));
  const databaseUrl = `file:${path.join(sandbox, 'animation-test.db')}`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.ANIMATION_STORAGE_ROOT = path.join(sandbox, 'private-storage');
  await writeFile(path.join(sandbox, 'animation-test.db'), Buffer.alloc(0), { mode: 0o600 });

  const prismaCli = path.join(projectRoot, 'node_modules/prisma/build/index.js');
  const setup = spawnSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', path.join(projectRoot, 'prisma/schema.prisma')], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  if (setup.status !== 0) {
    throw new Error([
      `Failed to prepare isolated animation SQLite database (exit ${setup.status ?? 'unknown'}).`,
      'stdout:', setup.stdout || '(empty)',
      'stderr:', setup.stderr || '(empty)',
      ...(setup.error ? [`spawn error: ${setup.error.message}`] : []),
    ].join('\n'));
  }

  ({ prisma } = await import('../src/lib/prisma'));
  ({ requireAnimationDocument, canCurrentActorRunAnimationJob } = await import('../src/lib/animation/access'));
  ({ getIdempotentResponse, animationRequestHash, createImportedAnimationDocument, createAnimationJob, registerAnimationCandidateFileInTransaction, reconcileAnimationUploadManifest, cancelAnimationDocumentJobs, patchAnimationDocument, preserveSequenceInvariants } = await import('../src/lib/animation/repository'));
  ({ matchesAnimationJobAttempt } = await import('../src/lib/animation/jobs'));
  ({ publishAnimationBlob, hasAnimationStorageCapacity, ANIMATION_IMPORT_RESERVED_BYTES: animationImportReservedBytes, hashFile, writeAnimationReconcileManifest, resolveAnimationBlob } = await import('../src/lib/animation/storage'));
  ({ exportAnimationBundle } = await import('../src/lib/animation/media'));
  ({ handleAnimationImportRequest, serveAnimationFileRequest, serveAnimationExportRequest } = await import('../src/lib/animation/request-handlers'));
});

after(async () => {
  await prisma?.$disconnect();
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

test('upload and job reservations share one safety-adjusted storage budget', () => {
  const gib = BigInt(1024) * BigInt(1024) * BigInt(1024);
  const smallFreeBytes = BigInt(1000);
  const smallSafetyReserve = BigInt(100);
  const oneAdmission = BigInt(500);
  assert.equal(animationImportReservedBytes, BigInt(6) * gib);

  assert.equal(hasAnimationStorageCapacity(smallFreeBytes, BigInt(0), BigInt(0), oneAdmission, smallSafetyReserve), true);
  assert.equal(hasAnimationStorageCapacity(smallFreeBytes, BigInt(0), oneAdmission, oneAdmission, smallSafetyReserve), false);
  assert.equal(hasAnimationStorageCapacity(smallFreeBytes, oneAdmission, BigInt(0), oneAdmission, smallSafetyReserve), false);
  assert.equal(hasAnimationStorageCapacity(smallFreeBytes, BigInt(0), BigInt(0), smallFreeBytes - smallSafetyReserve, smallSafetyReserve), true);
});

async function createUser(label: string, withFeishuIdentity = true): Promise<SessionUser> {
  const feishuUserId = withFeishuIdentity ? `test-feishu-${randomUUID()}` : null;
  const user = await prisma.user.create({
    data: {
      id: randomUUID(), name: label, username: `${label}-${randomUUID()}`, email: `${randomUUID()}@animation.test`, password_hash: 'test-only',
      account_type: 'internal', role: 'user', status: 'active', feishu_user_id: feishuUserId,
    },
  });
  return {
    id: user.id, name: user.name, username: user.username, email: user.email, role: 'user', account_type: 'internal',
    user_profile: user.user_profile, feature_profile_id: user.feature_profile_id, status: 'active', expires_at: null,
    feishu: { user_id: feishuUserId, open_id: null, union_id: null, tenant_key: null, employee_no: null, department_ids: [], last_sync_at: null },
  };
}

test('project viewers can read but cannot write, and a revoked membership is denied immediately', async () => {
  const owner = await createUser('owner');
  const viewer = await createUser('viewer');
  const project = await prisma.project.create({
    data: { id: randomUUID(), name: 'isolated-animation-project', owner_user_id: owner.id, created_by: owner.id, type: 'team', status: 'active' },
  });
  const membership = await prisma.projectMember.create({ data: { project_id: project.id, user_id: viewer.id, role: 'viewer', status: 'active' } });
  const document = await prisma.animationDocument.create({
    data: { id: randomUUID(), project_id: project.id, owner_user_id: owner.id, title: 'test', sequence_json: '{}', updated_at: new Date() },
  });

  const readAccess = await requireAnimationDocument(viewer, document.id, 'view');
  assert.equal(readAccess.canEdit, false);
  await assert.rejects(requireAnimationDocument(viewer, document.id, 'write'), (error: unknown) => (error as { status?: number }).status === 403);

  await prisma.projectMember.update({ where: { id: membership.id }, data: { status: 'removed' } });
  await assert.rejects(requireAnimationDocument(viewer, document.id, 'view'), (error: unknown) => (error as { status?: number }).status === 403);

  const importRequestId = `import-${randomUUID()}`;
  const importHash = animationRequestHash({ content: 'prior import' });
  await prisma.animationRequest.create({
    data: { id: randomUUID(), actor_user_id: viewer.id, request_id: importRequestId, operation: `import:${project.id}`, request_hash: importHash, document_id: document.id, response_json: JSON.stringify({ success: true, document: { id: document.id } }) },
  });
  await assert.rejects(createImportedAnimationDocument({
    user: viewer, projectId: project.id, requestId: importRequestId, requestHash: importHash, sequence: {} as AnimationSequence, title: 'replay', files: [],
  }), (error: unknown) => (error as { status?: number }).status === 403);

  const patchBody = { mutation_id: `mutation-${randomUUID()}`, base_revision: 1, status: 'archived' };
  const patchHash = animationRequestHash({ base_revision: 1, status: 'archived' });
  await prisma.animationRequest.create({
    data: { id: randomUUID(), actor_user_id: viewer.id, request_id: patchBody.mutation_id, operation: `patch:${document.id}`, request_hash: patchHash, document_id: document.id, response_json: JSON.stringify({ success: true, document: { id: document.id } }) },
  });
  await assert.rejects(patchAnimationDocument(viewer, document.id, patchBody), (error: unknown) => (error as { status?: number }).status === 403);
});

test('candidate registration rechecks archive state after the active preflight', async () => {
  const owner = await createUser('candidate-archive-race-owner');
  const project = await prisma.project.create({ data: { id: randomUUID(), name: 'candidate-archive-race-project', owner_user_id: owner.id, created_by: owner.id } });
  const document = await prisma.animationDocument.create({
    data: { id: randomUUID(), project_id: project.id, owner_user_id: owner.id, title: 'archive race', sequence_json: '{}', updated_at: new Date() },
  });
  const preflight = await requireAnimationDocument(owner, document.id, 'write');
  assert.equal(preflight.document.status, 'active');

  const metadata = {
    id: randomUUID(), name: 'candidate.png', role: 'candidate' as const, mime: 'image/png', bytes: 1,
    sha256: 'c'.repeat(64), width: 1, height: 1, blob_key: randomUUID(),
  };
  const requestId = `candidate-${randomUUID()}`;
  const input = {
    user: owner,
    documentId: document.id,
    requestId,
    requestHash: animationRequestHash({ sha256: metadata.sha256 }),
    operation: `file:${document.id}:candidate`,
    metadata,
  };

  await prisma.animationDocument.update({ where: { id: document.id }, data: { status: 'archived' } });
  await assert.rejects(
    prisma.$transaction((tx) => registerAnimationCandidateFileInTransaction(tx, input, preflight.document.project_id)),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409
      && (error as { code?: string }).code === 'DOCUMENT_ARCHIVED',
  );
  assert.equal(await prisma.animationFile.count({ where: { id: metadata.id } }), 0);
  assert.equal(await prisma.animationRequest.count({ where: { actor_user_id: owner.id, request_id: requestId } }), 0);
});

test('archived candidate reconciliation cleans only blobs not already registered', async () => {
  const owner = await createUser('candidate-reconcile-owner');
  const project = await prisma.project.create({ data: { id: randomUUID(), name: 'candidate-reconcile-project', owner_user_id: owner.id, created_by: owner.id } });
  const document = await prisma.animationDocument.create({
    data: { id: randomUUID(), project_id: project.id, owner_user_id: owner.id, title: 'archived reconcile', status: 'archived', sequence_json: '{}', updated_at: new Date() },
  });
  const makeManifest = (file: { id: string; blob_key: string; sha256: string }, requestId: string) => ({
    version: 1,
    kind: 'candidate_file',
    document_id: document.id,
    project_id: project.id,
    actor_user_id: owner.id,
    request_id: requestId,
    operation: `file:${document.id}:candidate`,
    request_hash: 'd'.repeat(64),
    file: {
      ...file, name: 'candidate.png', role: 'candidate', mime: 'image/png', bytes: 1, width: 1, height: 1,
    },
    pose: { id: 'candidate-pose', width: 1, height: 1 },
  });
  const abandoned = { id: randomUUID(), blob_key: randomUUID(), sha256: 'e'.repeat(64) };
  const abandonedResult = await reconcileAnimationUploadManifest(makeManifest(abandoned, `reconcile-${randomUUID()}`));
  assert.deepEqual(abandonedResult.cleanupBlobKeys, [abandoned.blob_key]);

  const retained = { id: randomUUID(), blob_key: randomUUID(), sha256: 'f'.repeat(64) };
  await prisma.animationFile.create({
    data: {
      ...retained, document_id: document.id, project_id: project.id, created_by: owner.id, name: 'candidate.png',
      role: 'candidate', mime: 'image/png', bytes: 1, width: 1, height: 1,
    },
  });
  const retainedResult = await reconcileAnimationUploadManifest(makeManifest(retained, `reconcile-${randomUUID()}`));
  assert.deepEqual(retainedResult.cleanupBlobKeys, []);
});

test('sequence file references and original geometry must match registered PNG metadata', async () => {
  const owner = await createUser('reference-owner');
  const project = await prisma.project.create({ data: { id: randomUUID(), name: 'isolated-reference-project', owner_user_id: owner.id, created_by: owner.id } });
  const poseFileId = randomUUID();
  const referenceFileId = randomUUID();
  const files = [
    { id: poseFileId, name: 'pose.png', role: 'pose' as const, mime: 'image/png', bytes: 100, sha256: '1'.repeat(64), width: 64, height: 64, blob_key: randomUUID() },
    { id: referenceFileId, name: 'reference.png', role: 'reference' as const, mime: 'image/png', bytes: 100, sha256: '2'.repeat(64), width: 64, height: 64, blob_key: randomUUID() },
  ];
  const sequence: AnimationSequence = {
    schema_version: 1, title: 'reference test', preview_fps: 12, tick_rate: null, tick_rate_verified: false, global_scale: 1,
    poses: [{ id: 'pose-1', file_id: poseFileId, label: 'frame', width: 64, height: 64, logical_width: null, logical_height: null, pixels_per_unit: null, source: {} }],
    entries: [{ id: 'entry-1', action: 'idle', pose_id: 'pose-1', reference_file_id: referenceFileId, reference_geometry: { logical_width: 64, logical_height: 64, pixels_per_unit: 1, source: 'media-source-policy' }, hold_ticks: 3, original_hold_ticks: 3, locked: false, translate_x: 0, translate_y: 0 }],
    notes: '', user_accepted_for_retention: false, historical_review: '',
  };

  const imported = await createImportedAnimationDocument({
    user: owner, projectId: project.id, requestId: `import-${randomUUID()}`, requestHash: animationRequestHash({ bundle: 'valid-reference' }),
    sequence, title: sequence.title, files,
  });
  assert.equal(imported.document.files.find((file) => file.id === referenceFileId)?.role, 'reference');
  assert.deepEqual(imported.document.sequence.entries[0].reference_geometry, sequence.entries[0].reference_geometry);

  const editedSequence = structuredClone(sequence);
  editedSequence.notes = 'first saved change';
  const firstEdit = await patchAnimationDocument(owner, imported.document.id, {
    base_revision: 1, mutation_id: `mutation-${randomUUID()}`, sequence: editedSequence,
  });
  assert.equal(firstEdit.document.revision, 2);
  const staleSequence = structuredClone(sequence);
  staleSequence.historical_review = 'stale write';
  await assert.rejects(patchAnimationDocument(owner, imported.document.id, {
    base_revision: 1, mutation_id: `mutation-${randomUUID()}`, sequence: staleSequence,
  }), (error: unknown) => (error as { status?: number; currentRevision?: number }).status === 409
    && (error as { currentRevision?: number }).currentRevision === 2);

  const isolatedFiles = () => files.map((file) => ({ ...file, id: randomUUID(), blob_key: randomUUID() }));
  const remapFileIds = (source: AnimationSequence, targetFiles: ReturnType<typeof isolatedFiles>) => {
    const next = structuredClone(source);
    next.poses[0].file_id = targetFiles[0].id;
    next.entries[0].reference_file_id = targetFiles[1].id;
    return next;
  };

  const mismatchedFiles = isolatedFiles();
  const mismatched = remapFileIds(sequence, mismatchedFiles);
  mismatched.poses[0].width = 32;
  const failedGeometryDocumentId = randomUUID();
  await assert.rejects(createImportedAnimationDocument({
    user: owner, documentId: failedGeometryDocumentId, projectId: project.id, requestId: `import-${randomUUID()}`,
    requestHash: animationRequestHash({ bundle: 'forged-dimensions' }), sequence: mismatched, title: mismatched.title, files: mismatchedFiles,
  }), (error: unknown) => (error as { code?: string }).code === 'INVALID_FILE_REFERENCE');
  assert.equal(await prisma.animationDocument.findUnique({ where: { id: failedGeometryDocumentId } }), null);

  const badReferenceGeometryFiles = isolatedFiles();
  const badReferenceGeometry = remapFileIds(sequence, badReferenceGeometryFiles);
  badReferenceGeometry.entries[0].reference_geometry!.logical_width = 32;
  await assert.rejects(createImportedAnimationDocument({
    user: owner, projectId: project.id, requestId: `import-${randomUUID()}`,
    requestHash: animationRequestHash({ bundle: 'forged-reference-geometry' }),
    sequence: badReferenceGeometry, title: badReferenceGeometry.title, files: badReferenceGeometryFiles,
  }), (error: unknown) => (error as { code?: string }).code === 'INVALID_REFERENCE_GEOMETRY');
});

test('createAnimationJob reserves the ten-GiB conservative budget as BigInt beyond the signed 32-bit limit', async () => {
  const owner = await createUser('bigint-job-owner');
  const project = await prisma.project.create({ data: { id: randomUUID(), name: 'bigint-job-project', owner_user_id: owner.id, created_by: owner.id } });
  const documentId = randomUUID();
  const fileId = randomUUID();
  const sequence: AnimationSequence = {
    schema_version: 1, title: 'BigInt queue reservation', preview_fps: 12, tick_rate: null, tick_rate_verified: false, global_scale: 1,
    poses: [{ id: 'pose-queue', file_id: fileId, label: 'frame', width: 16, height: 16, logical_width: null, logical_height: null, pixels_per_unit: null, source: {} }],
    entries: [{ id: 'entry-queue', action: 'idle', pose_id: 'pose-queue', hold_ticks: 2, original_hold_ticks: 2, locked: false, translate_x: 0, translate_y: 0 }],
    notes: '', user_accepted_for_retention: false, historical_review: '',
  };
  await prisma.animationDocument.create({
    data: { id: documentId, project_id: project.id, owner_user_id: owner.id, title: sequence.title, sequence_json: JSON.stringify(sequence) },
  });
  await prisma.animationFile.create({
    data: {
      id: fileId, document_id: documentId, project_id: project.id, created_by: owner.id, name: 'pose.png', role: 'pose',
      mime: 'image/png', bytes: 128, sha256: 'a'.repeat(64), width: 16, height: 16, blob_key: randomUUID(),
    },
  });

  const tenGiB = BigInt(10) * BigInt(1024) * BigInt(1024) * BigInt(1024);
  try {
    const result = await createAnimationJob(owner, documentId, {
      base_revision: 1, mutation_id: `mutation-${randomUUID()}`, kind: 'export', parameters: { mode: 'work_copy' },
    });
    assert.equal(result.job.status, 'queued');
    assert.doesNotThrow(() => JSON.stringify(result));

    const [job, queue] = await Promise.all([
      prisma.animationJob.findMany({ where: { document_id: documentId }, orderBy: { created_at: 'asc' } }),
      prisma.animationQueueState.findUnique({ where: { id: 'global' } }),
    ]);
    assert.equal(job.length, 1);
    assert.equal(job[0].reserved_storage_bytes, tenGiB);
    assert.equal(queue?.reserved_storage_bytes, tenGiB);
    assert.ok((queue?.reserved_storage_bytes ?? BigInt(0)) > BigInt(2_147_483_647));
  } finally {
    await prisma.$transaction((tx) => cancelAnimationDocumentJobs(tx, documentId, 'test cleanup'));
  }
  const queueAfterCleanup = await prisma.animationQueueState.findUnique({ where: { id: 'global' } });
  assert.equal(queueAfterCleanup?.reserved_storage_bytes, BigInt(0));
});

test('transactional admission and worker authorization reject an internal account without Feishu identity', async () => {
  const emailOnly = await createUser('email-only-internal', false);
  const project = await prisma.project.create({ data: { id: randomUUID(), name: 'email-only-project', owner_user_id: emailOnly.id, created_by: emailOnly.id } });
  const document = await prisma.animationDocument.create({
    data: { id: randomUUID(), project_id: project.id, owner_user_id: emailOnly.id, title: 'blocked job', sequence_json: '{}' },
  });
  await assert.rejects(createAnimationJob(emailOnly, document.id, {
    base_revision: 1, mutation_id: `mutation-${randomUUID()}`, kind: 'export', parameters: { mode: 'work_copy' },
  }), (error: unknown) => (error as { status?: number }).status === 401);
  assert.equal(await canCurrentActorRunAnimationJob(emailOnly.id, project.id, emailOnly.id), false);

  await prisma.animationQueueState.upsert({
    where: { id: 'global' },
    create: { id: 'global', active_count: 1, reserved_storage_bytes: BigInt(0) },
    update: { active_count: { increment: 1 } },
  });
  const job = await prisma.animationJob.create({
    data: {
      id: randomUUID(), document_id: document.id, project_id: project.id, actor_user_id: emailOnly.id, kind: 'export', status: 'queued',
      revision: 1, parameters_json: '{}', parameters_hash: 'email-only', stage: 'queued', attempt: 0,
      queue_reserved: true, reserved_storage_bytes: BigInt(0), timeout_at: new Date(Date.now() + 60_000),
    },
  });
  const run = runWorkerOnce();
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const rejectedJob = await prisma.animationJob.findUnique({ where: { id: job.id } });
  assert.equal(rejectedJob?.status, 'cancelled');
  assert.equal(rejectedJob?.error_code, 'ACCESS_REVOKED');
});

test('a request id replays the same response and rejects a different request hash', async () => {
  const actor = await createUser('request-owner');
  const requestId = `request-${randomUUID()}`;
  const hash = animationRequestHash({ sha256: 'a'.repeat(64) });
  const response = { success: true, value: 'stored-response' };
  await prisma.animationRequest.create({
    data: { id: randomUUID(), actor_user_id: actor.id, request_id: requestId, operation: 'test-upload', request_hash: hash, response_json: JSON.stringify(response) },
  });

  assert.deepEqual(await getIdempotentResponse(actor.id, requestId, 'test-upload', hash), response);
  await assert.rejects(
    getIdempotentResponse(actor.id, requestId, 'test-upload', animationRequestHash({ sha256: 'b'.repeat(64) })),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409 && (error as { code?: string }).code === 'IDEMPOTENCY_CONFLICT',
  );
});

async function createImportBundle(title: string) {
  const fileId = randomUUID();
  const sourcePath = path.join(sandbox, `${fileId}.png`);
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 120, g: 90, b: 40, alpha: 1 } } }).png().toFile(sourcePath);
  const bytes = (await stat(sourcePath)).size;
  const sequence: AnimationSequence = {
    schema_version: 1, title, preview_fps: 12, tick_rate: null, tick_rate_verified: false, global_scale: 1,
    poses: [{ id: 'pose-import', file_id: fileId, label: 'source', width: 16, height: 16, logical_width: null, logical_height: null, pixels_per_unit: null, source: {} }],
    entries: [{ id: 'entry-import', action: 'idle', pose_id: 'pose-import', hold_ticks: 2, original_hold_ticks: 2, locked: false, translate_x: 0, translate_y: 0 }],
    notes: '', user_accepted_for_retention: false, historical_review: '',
  };
  const outputDirectory = path.join(sandbox, `bundle-${randomUUID()}`);
  await mkdir(outputDirectory, { mode: 0o700 });
  const bundle = await exportAnimationBundle({
    sequence,
    files: [{ id: fileId, name: 'source.png', role: 'pose', mime: 'image/png', bytes, sha256: await hashFile(sourcePath), width: 16, height: 16, path: sourcePath }],
    outputDir: outputDirectory,
    mode: 'work_copy',
  });
  return readFile(bundle.path);
}

function importRequest(projectId: string, requestId: string, bundle: Buffer) {
  const body = new ArrayBuffer(bundle.byteLength);
  new Uint8Array(body).set(bundle);
  return new NextRequest(`https://animation.test/api/animation/import?project_id=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    headers: {
      host: 'animation.test',
      origin: 'https://animation.test',
      'content-type': 'application/zip',
      'content-length': String(bundle.byteLength),
      'x-request-id': requestId,
    },
    body,
  });
}

test('the import route accepts a real bundle with an absent media output directory and replays by content hash', async () => {
  const owner = await createUser('route-import-owner');
  const project = await prisma.project.create({ data: { id: randomUUID(), name: 'route-import-project', owner_user_id: owner.id, created_by: owner.id } });
  const bundle = await createImportBundle('route import');
  const requestId = `route-import-${randomUUID()}`;

  const firstResponse = await handleAnimationImportRequest(importRequest(project.id, requestId, bundle), owner);
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json() as { success: boolean; document: { id: string; revision: number; sequence: AnimationSequence } };
  assert.equal(first.success, true);
  assert.equal(first.document.revision, 1);

  const replayResponse = await handleAnimationImportRequest(importRequest(project.id, requestId, bundle), owner);
  const replay = await replayResponse.json() as { success: boolean; document: { id: string } };
  assert.equal(replay.document.id, first.document.id);

  const differentBundle = Buffer.concat([bundle, Buffer.from('different-content')]);
  await assert.rejects(
    handleAnimationImportRequest(importRequest(project.id, requestId, differentBundle), owner),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409
      && (error as { code?: string }).code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('private file and export GET, HEAD, and Range handlers reject cross-project requests', async () => {
  const owner = await createUser('private-asset-owner');
  const outsider = await createUser('private-asset-outsider');
  const project = await prisma.project.create({ data: { id: randomUUID(), name: 'private-asset-project', owner_user_id: owner.id, created_by: owner.id } });
  await prisma.project.create({ data: { id: randomUUID(), name: 'outsider-project', owner_user_id: outsider.id, created_by: outsider.id } });
  const document = await prisma.animationDocument.create({
    data: { id: randomUUID(), project_id: project.id, owner_user_id: owner.id, title: 'private', sequence_json: '{}', updated_at: new Date() },
  });
  const siblingDocument = await prisma.animationDocument.create({
    data: { id: randomUUID(), project_id: project.id, owner_user_id: owner.id, title: 'same project sibling', sequence_json: '{}', updated_at: new Date() },
  });
  const bytes = Buffer.from('private animation payload');
  const sourcePath = path.join(sandbox, `${randomUUID()}.bin`);
  await writeFile(sourcePath, bytes);
  const blob = await publishAnimationBlob(sourcePath);
  const file = await prisma.animationFile.create({
    data: {
      id: randomUUID(), document_id: document.id, project_id: project.id, created_by: owner.id, name: 'private.png', role: 'candidate',
      mime: 'image/png', bytes: blob.bytes, sha256: blob.sha256, width: 1, height: 1, blob_key: blob.blob_key,
    },
  });
  const job = await prisma.animationJob.create({
    data: {
      id: randomUUID(), document_id: document.id, project_id: project.id, actor_user_id: owner.id, kind: 'export', status: 'succeeded',
      revision: 1, parameters_json: '{}', parameters_hash: 'private-test', stage: 'complete', timeout_at: new Date(Date.now() + 60_000),
    },
  });
  const exported = await prisma.animationExport.create({
    data: {
      id: randomUUID(), document_id: document.id, project_id: project.id, job_id: job.id, revision: 1, mode: 'work_copy',
      blob_key: blob.blob_key, file_name: 'private.zip', bytes: blob.bytes, sha256: blob.sha256, entry_count: 0, total_ticks: 0, warnings_json: '[]',
    },
  });

  const cases = [
    { method: 'GET', range: undefined },
    { method: 'HEAD', range: undefined },
    { method: 'GET', range: 'bytes=0-3' },
  ];
  for (const routeCase of cases) {
    const fileRequest = new NextRequest(`https://animation.test/api/animation/files/${file.id}?document_id=${document.id}`, {
      method: routeCase.method,
      headers: routeCase.range ? { range: routeCase.range } : undefined,
    });
    await assert.rejects(serveAnimationFileRequest(fileRequest, file.id, routeCase.method === 'HEAD', outsider), (error: unknown) => {
      const failure = error as { status?: number; message?: string };
      return failure.status === 403 && !failure.message?.includes(blob.path);
    });

    const exportRequest = new NextRequest(`https://animation.test/api/animation/exports/${exported.id}?document_id=${document.id}`, {
      method: routeCase.method,
      headers: routeCase.range ? { range: routeCase.range } : undefined,
    });
    await assert.rejects(serveAnimationExportRequest(exportRequest, exported.id, routeCase.method === 'HEAD', outsider), (error: unknown) => {
      const failure = error as { status?: number; message?: string };
      return failure.status === 403 && !failure.message?.includes(blob.path);
    });

    const wrongDocumentFileRequest = new NextRequest(`https://animation.test/api/animation/files/${file.id}?document_id=${siblingDocument.id}`, {
      method: routeCase.method,
      headers: routeCase.range ? { range: routeCase.range } : undefined,
    });
    await assert.rejects(serveAnimationFileRequest(wrongDocumentFileRequest, file.id, routeCase.method === 'HEAD', owner), (error: unknown) => {
      const failure = error as { status?: number; message?: string };
      return failure.status === 404 && !failure.message?.includes(blob.path);
    });

    const wrongDocumentExportRequest = new NextRequest(`https://animation.test/api/animation/exports/${exported.id}?document_id=${siblingDocument.id}`, {
      method: routeCase.method,
      headers: routeCase.range ? { range: routeCase.range } : undefined,
    });
    await assert.rejects(serveAnimationExportRequest(wrongDocumentExportRequest, exported.id, routeCase.method === 'HEAD', owner), (error: unknown) => {
      const failure = error as { status?: number; message?: string };
      return failure.status === 404 && !failure.message?.includes(blob.path);
    });
  }
});

test('locked frame guards compare full pose content, global scale, and immutable hold baseline', () => {
  const previous: AnimationSequence = {
    schema_version: 1, title: 'locked', preview_fps: 12, tick_rate: 60, tick_rate_verified: true, global_scale: 1,
    poses: [{ id: 'pose-1', file_id: 'file-1', label: 'frame', width: 32, height: 32, logical_width: 32, logical_height: 32, pixels_per_unit: 1, source: {} }],
    entries: [{ id: 'entry-1', action: 'idle', pose_id: 'pose-1', hold_ticks: 3, original_hold_ticks: 3, locked: true, translate_x: 0, translate_y: 0 }],
    notes: '', user_accepted_for_retention: false, historical_review: '',
  };
  const unlocked = structuredClone(previous);
  unlocked.entries[0].locked = false;
  const changedPose = structuredClone(previous);
  changedPose.poses[0].file_id = 'file-2';
  assert.throws(() => preserveSequenceInvariants(previous, changedPose), { code: 'ENTRY_LOCKED' });

  const changedScale = structuredClone(previous);
  changedScale.global_scale = 1.25;
  assert.throws(() => preserveSequenceInvariants(previous, changedScale), { code: 'ENTRY_LOCKED' });

  const changedBaseline = structuredClone(previous);
  changedBaseline.entries[0].hold_ticks = 4;
  changedBaseline.entries[0].original_hold_ticks = 4;
  assert.throws(() => preserveSequenceInvariants(previous, changedBaseline), { code: 'HOLD_BASELINE_IMMUTABLE' });

  const rekeyedEntry = structuredClone(unlocked);
  rekeyedEntry.entries[0].id = 'replacement-entry';
  assert.throws(() => preserveSequenceInvariants(unlocked, rekeyedEntry), { code: 'ENTRY_ID_IMMUTABLE' });

  const referenceBase = structuredClone(unlocked);
  referenceBase.entries[0].reference_file_id = 'original-reference';
  referenceBase.entries[0].reference_geometry = { logical_width: 32, logical_height: 32, pixels_per_unit: 1, source: 'original-policy' };

  const changedReference = structuredClone(referenceBase);
  changedReference.entries[0].reference_file_id = 'replacement-reference';
  assert.throws(() => preserveSequenceInvariants(referenceBase, changedReference), { code: 'REFERENCE_BASELINE_IMMUTABLE' });

  const changedReferenceGeometry = structuredClone(referenceBase);
  changedReferenceGeometry.entries[0].reference_geometry!.pixels_per_unit = 2;
  assert.throws(() => preserveSequenceInvariants(referenceBase, changedReferenceGeometry), { code: 'REFERENCE_BASELINE_IMMUTABLE' });

  const rekeyedReference = structuredClone(referenceBase);
  rekeyedReference.entries[0].id = 'replacement-entry';
  rekeyedReference.entries[0].reference_file_id = 'replacement-reference';
  assert.throws(() => preserveSequenceInvariants(referenceBase, rekeyedReference), { code: 'REFERENCE_BASELINE_IMMUTABLE' });

  assert.equal(preserveSequenceInvariants(previous, unlocked).entries[0].locked, false);

  const changedGeometry = structuredClone(unlocked);
  changedGeometry.poses[0].logical_width = 64;
  assert.throws(() => preserveSequenceInvariants(unlocked, changedGeometry), { code: 'ORIGINAL_GEOMETRY_IMMUTABLE' });

  const selectedCandidate = structuredClone(unlocked);
  selectedCandidate.poses.push({ id: 'pose-2', file_id: 'candidate-file', label: 'candidate', width: 64, height: 64, logical_width: null, logical_height: null, pixels_per_unit: null, source: {} });
  selectedCandidate.entries[0].pose_id = 'pose-2';
  assert.equal(preserveSequenceInvariants(unlocked, selectedCandidate).entries[0].pose_id, 'pose-2');

  const candidateWithTransformChange = structuredClone(selectedCandidate);
  candidateWithTransformChange.entries[0].translate_x = 4;
  assert.throws(() => preserveSequenceInvariants(unlocked, candidateWithTransformChange), { code: 'CANDIDATE_SELECTION_ONLY' });

  const candidateWithReferenceChange = structuredClone(referenceBase);
  candidateWithReferenceChange.poses.push({ id: 'pose-2', file_id: 'candidate-file', label: 'candidate', width: 64, height: 64, logical_width: null, logical_height: null, pixels_per_unit: null, source: {} });
  candidateWithReferenceChange.entries[0].pose_id = 'pose-2';
  assert.equal(preserveSequenceInvariants(referenceBase, candidateWithReferenceChange).entries[0].reference_file_id, 'original-reference');
  assert.deepEqual(preserveSequenceInvariants(referenceBase, candidateWithReferenceChange).entries[0].reference_geometry, referenceBase.entries[0].reference_geometry);
});

test('a reclaimed job attempt cannot be mistaken for the previous publishing attempt', async () => {
  const actor = await createUser('worker-owner');
  const project = await prisma.project.create({ data: { id: randomUUID(), name: 'isolated-worker-project', owner_user_id: actor.id, created_by: actor.id } });
  const document = await prisma.animationDocument.create({
    data: { id: randomUUID(), project_id: project.id, owner_user_id: actor.id, title: 'worker', sequence_json: '{}', updated_at: new Date() },
  });
  const oldLease = randomUUID();
  const job = await prisma.animationJob.create({
    data: {
      id: randomUUID(), document_id: document.id, project_id: project.id, actor_user_id: actor.id, kind: 'export', status: 'running',
      revision: 1, parameters_json: '{}', parameters_hash: 'test', stage: 'publishing', attempt: 1, lease_token: oldLease,
      timeout_at: new Date(Date.now() + 60_000),
    },
  });
  assert.equal(matchesAnimationJobAttempt(null, oldLease, 1), false);
  assert.equal(matchesAnimationJobAttempt(job, oldLease, 1), true);

  const reclaimed = await prisma.animationJob.update({ where: { id: job.id }, data: { attempt: 2, lease_token: randomUUID() } });
  assert.equal(matchesAnimationJobAttempt(reclaimed, oldLease, 1), false);
  assert.equal(matchesAnimationJobAttempt(reclaimed, reclaimed.lease_token || '', 2), true);
});

async function seedOneShotWorkerJob(kind: 'export' | 'extract', sourceVideoPath?: string) {
  const actor = await createUser(`oneshot-${kind}`);
  const project = await prisma.project.create({ data: { id: randomUUID(), name: `oneshot-${kind}`, owner_user_id: actor.id, created_by: actor.id } });
  const documentId = randomUUID();
  const pngSourcePath = path.join(sandbox, `${randomUUID()}.png`);
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 80, g: 140, b: 200, alpha: 1 } } }).png().toFile(pngSourcePath);
  const pngBlob = await publishAnimationBlob(pngSourcePath);
  assert.equal(path.extname(pngBlob.path), '');
  const poseFileId = randomUUID();
  const sequence: AnimationSequence = {
    schema_version: 1, title: `one-shot ${kind}`, preview_fps: 12, tick_rate: null, tick_rate_verified: false, global_scale: 1,
    poses: [{ id: 'pose-source', file_id: poseFileId, label: 'source', width: 16, height: 16, logical_width: 16, logical_height: 16, pixels_per_unit: 1, source: {} }],
    entries: [{ id: 'entry-source', action: 'idle', pose_id: 'pose-source', hold_ticks: 2, original_hold_ticks: 2, locked: false, translate_x: 0, translate_y: 0 }],
    notes: '', user_accepted_for_retention: false, historical_review: '',
  };
  await prisma.animationDocument.create({
    data: { id: documentId, project_id: project.id, owner_user_id: actor.id, title: sequence.title, revision: 1, sequence_json: JSON.stringify(sequence) },
  });
  await prisma.animationRevision.create({
    data: { id: randomUUID(), document_id: documentId, revision: 1, sequence_json: JSON.stringify(sequence), actor_user_id: actor.id, reason: 'import' },
  });
  await prisma.animationFile.create({
    data: { id: poseFileId, document_id: documentId, project_id: project.id, created_by: actor.id, name: 'source.png', role: 'pose', mime: 'image/png', bytes: pngBlob.bytes, sha256: pngBlob.sha256, width: 16, height: 16, blob_key: path.basename(pngBlob.path) },
  });

  let parameters: Record<string, unknown> = { mode: 'work_copy' };
  if (kind === 'extract') {
    if (!sourceVideoPath) throw new Error('extract fixture requires a video path');
    const videoBlob = await publishAnimationBlob(sourceVideoPath);
    assert.equal(path.extname(videoBlob.path), '');
    const videoFileId = randomUUID();
    await prisma.animationFile.create({
      data: { id: videoFileId, document_id: documentId, project_id: project.id, created_by: actor.id, name: 'source.mp4', role: 'video', mime: 'video/mp4', bytes: videoBlob.bytes, sha256: videoBlob.sha256, width: 16, height: 16, blob_key: path.basename(videoBlob.path) },
    });
    parameters = { video_file_id: videoFileId, frame_index: 0 };
  }

  const jobId = randomUUID();
  await prisma.animationQueueState.upsert({
    where: { id: 'global' },
    create: { id: 'global', active_count: 1, reserved_storage_bytes: BigInt(0) },
    update: { active_count: { increment: 1 } },
  });
  await prisma.animationJob.create({
    data: {
      id: jobId, document_id: documentId, project_id: project.id, actor_user_id: actor.id, kind, status: 'queued', revision: 1,
      parameters_json: JSON.stringify(parameters), parameters_hash: animationRequestHash(parameters), stage: 'queued', attempt: 0,
      queue_reserved: true, reserved_storage_bytes: BigInt(0), timeout_at: new Date(Date.now() + 120_000),
    },
  });
  return { documentId, jobId };
}

function runWorkerOnce() {
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(projectRoot, 'scripts/process-animation-jobs.ts'), '--once'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, ANIMATION_STORAGE_ROOT: process.env.ANIMATION_STORAGE_ROOT },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

test('worker --once reconciles a published blob for the exact active attempt after a registration handoff', async () => {
  const { jobId, documentId } = await seedOneShotWorkerJob('export');
  const leaseToken = randomUUID();
  await prisma.animationJob.update({
    where: { id: jobId },
    data: { status: 'running', stage: 'publishing', attempt: 1, lease_token: leaseToken },
  });
  const artifactPath = path.join(sandbox, `${randomUUID()}.zip`);
  await writeFile(artifactPath, Buffer.from('previously validated animation export'));
  const artifact = await publishAnimationBlob(artifactPath);
  const manifestPath = await writeAnimationReconcileManifest(randomUUID(), {
    version: 1,
    kind: 'job_export',
    job_id: jobId,
    attempt: 1,
    lease_token: leaseToken,
    worker_token: randomUUID(),
    document_id: documentId,
    project_id: (await prisma.animationDocument.findUniqueOrThrow({ where: { id: documentId } })).project_id,
    revision: 1,
    export: {
      blob_key: artifact.blob_key, file_name: 'recovered.zip', bytes: artifact.bytes, sha256: artifact.sha256,
      entry_count: 1, total_ticks: 2, mode: 'work_copy', warnings: [],
    },
  });

  const run = runWorkerOnce();
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const [job, exported] = await Promise.all([
    prisma.animationJob.findUnique({ where: { id: jobId } }),
    prisma.animationExport.findUnique({ where: { job_id: jobId } }),
  ]);
  assert.equal(job?.status, 'succeeded', job?.error_message ?? job?.error_code ?? 'job did not succeed');
  assert.equal(exported?.blob_key, artifact.blob_key);
  assert.equal(exported?.revision, 1);
  await assert.rejects(readFile(manifestPath));
});

test('worker --once discards a late blob from an older attempt instead of publishing it', async () => {
  const { jobId, documentId } = await seedOneShotWorkerJob('export');
  const oldLeaseToken = randomUUID();
  await prisma.animationJob.update({
    where: { id: jobId },
    data: { status: 'cancelled', stage: 'cancelled', attempt: 2, lease_token: null, queue_reserved: false, reserved_storage_bytes: BigInt(0) },
  });
  const artifactPath = path.join(sandbox, `${randomUUID()}.zip`);
  await writeFile(artifactPath, Buffer.from('late output from stale attempt'));
  const artifact = await publishAnimationBlob(artifactPath);
  const manifestPath = await writeAnimationReconcileManifest(randomUUID(), {
    version: 1,
    kind: 'job_export',
    job_id: jobId,
    attempt: 1,
    lease_token: oldLeaseToken,
    worker_token: randomUUID(),
    document_id: documentId,
    project_id: (await prisma.animationDocument.findUniqueOrThrow({ where: { id: documentId } })).project_id,
    revision: 1,
    export: {
      blob_key: artifact.blob_key, file_name: 'stale.zip', bytes: artifact.bytes, sha256: artifact.sha256,
      entry_count: 1, total_ticks: 2, mode: 'work_copy', warnings: [],
    },
  });

  const run = runWorkerOnce();
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const job = await prisma.animationJob.findUnique({ where: { id: jobId } });
  assert.equal(job?.status, 'cancelled');
  assert.equal(job?.attempt, 2);
  assert.equal(await prisma.animationExport.count({ where: { job_id: jobId } }), 0);
  await assert.rejects(resolveAnimationBlob(artifact.blob_key));
  await assert.rejects(readFile(manifestPath));
});

test('worker --once exports from a verified extensionless private blob via an attempt-local PNG copy', async () => {
  const { jobId } = await seedOneShotWorkerJob('export');
  const run = runWorkerOnce();
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const job = await prisma.animationJob.findUnique({ where: { id: jobId } });
  assert.equal(job?.status, 'succeeded', job?.error_message ?? job?.error_code ?? 'job did not succeed');
  assert.equal(await prisma.animationExport.count({ where: { job_id: jobId } }), 1);
});

test('worker --once extracts from a verified extensionless private blob via an attempt-local MP4 copy', async (t) => {
  const available = ['ffmpeg', 'ffprobe'].every((tool) => {
    const result = spawnSync(tool, ['-version'], { stdio: 'ignore', timeout: 3_000 });
    return !result.error && result.status === 0;
  });
  if (!available) {
    t.skip('ffmpeg/ffprobe are unavailable');
    return;
  }
  const sourceVideoPath = path.join(sandbox, `${randomUUID()}.mp4`);
  const generated = spawnSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:r=24:d=1',
    '-frames:v', '2', '-an', '-c:v', 'mpeg4', '-q:v', '2', sourceVideoPath,
  ], { encoding: 'utf8', timeout: 15_000 });
  if (generated.error || generated.status !== 0) {
    t.skip('local ffmpeg cannot create the small MP4 fixture');
    return;
  }
  const { documentId, jobId } = await seedOneShotWorkerJob('extract', sourceVideoPath);
  const run = runWorkerOnce();
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const [job, candidate, document] = await Promise.all([
    prisma.animationJob.findUnique({ where: { id: jobId } }),
    prisma.animationFile.findFirst({ where: { document_id: documentId, role: 'candidate' } }),
    prisma.animationDocument.findUnique({ where: { id: documentId } }),
  ]);
  assert.equal(job?.status, 'succeeded', job?.error_message ?? job?.error_code ?? 'job did not succeed');
  assert.equal(candidate?.mime, 'image/png');
  assert.equal(document?.revision, 1, 'extracted candidate must not alter the sequence revision');
});
