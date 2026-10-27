import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { MultiviewWorkManifest } from '../src/lib/video/multiview-work-contract';

/** MV05 storage/permission engineering, not a media render or production test. */
async function main() {
  const root = realpathSync(process.cwd());
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'multiview-works-'));
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined, 'Start in a new process');
  const databasePath = path.join(directory, 'synthetic.db');
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  Object.assign(process.env, { NODE_ENV: 'test' });
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  globalThis.fetch = async () => { throw new Error('Network prohibited in MV05 isolated engineering'); };
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, { DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' });
  execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, stdio: 'pipe', timeout: 120000 });
  const schema = JSON.parse(execFileSync('python3', [path.join(root, 'scripts/check-multiview-works-schema.py'), '--database', databasePath], { cwd: directory, env, encoding: 'utf8' }));
  assert.equal(schema.state, 'compatible'); assert.equal(schema.writes, 0);
  const require = createRequire(import.meta.url);
  const { requestAsyncStorage } = require('./fixtures/next-request-context') as typeof import('./fixtures/next-request-context');
  const { RequestCookies } = require('next/dist/compiled/@edge-runtime/cookies') as typeof import('next/dist/compiled/@edge-runtime/cookies');
  const { NextRequest } = await import('next/server');
  const { prisma } = await import('../src/lib/prisma');
  const { createSession, SESSION_COOKIE } = await import('../src/lib/auth/session');
  const work = await import('../src/lib/video/multiview-works');
  const contract = await import('../src/lib/video/multiview-work-contract');
  const { multiviewSourceVersion } = await import('../src/lib/video/multiview');
  const listRoute = await import('../src/app/api/video/multiview/works/route');
  const checks: string[] = [];
  const originalCwd = process.cwd();
  // Source stat/hash is exercised on an isolated synthetic file, not decoded.
  // Full ffmpeg/frame/file acceptance belongs to the companion render package.
  mkdirSync(path.join(directory, '.media', 'videos'), { recursive: true });
  mkdirSync(path.join(directory, '.media', 'uploads'), { recursive: true });
  writeFileSync(path.join(directory, '.media', 'videos', 'synthetic.mp4'), 'isolated source identity fixture', { mode: 0o600 });
  process.chdir(directory);
  let completed = false;
  try {
    assert.equal(await prisma.user.count(), 0);
    for (const [id, role, account_type] of [['mv05-owner', 'user', 'internal'], ['mv05-other', 'user', 'internal'], ['mv05-admin', 'admin', 'internal'], ['mv05-external', 'user', 'external']] as const) {
      await prisma.user.create({ data: { id, name: 'Synthetic actor', username: id, email: `${id}@isolated.invalid`, password_hash: 'synthetic-not-a-password',
        role, account_type, feature_profile_id: account_type === 'internal' && role === 'user' ? 'internal_email_authorized' : null } });
    }
    const user = await work.multiviewWorkActor('mv05-owner');
    const other = await work.multiviewWorkActor('mv05-other');
    const admin = await work.multiviewWorkActor('mv05-admin');
    await prisma.videoTask.create({ data: { id: 'mv05-source-task', provider: 'seedance', model: 'synthetic', generation_mode: 'all_in_one_reference', prompt: 'synthetic',
      user_id: user.id, owner_user_id: user.id, local_status: 'succeeded', local_video_path: '/videos/synthetic.mp4' } });
    assert.equal((await work.listMultiviewWorks(user, { taskId: 'mv05-source-task' })).total, 0);
    assert.equal(await prisma.multiviewWork.count(), 0, 'Reading an old source never backfills a work');
    const intent = await prisma.$transaction(db => work.registerMultiviewWorkIntent(db, { ownerId: user.id, taskId: 'mv05-source-task', projectId: null, videoCardId: null }));
    assert.equal((await prisma.$transaction(db => work.registerMultiviewWorkIntent(db, { ownerId: user.id, taskId: 'mv05-source-task', projectId: null, videoCardId: null }))).id, intent.id);
    assert.equal(await prisma.multiviewWork.count(), 1);
    assert.equal((await work.listMultiviewWorks(user, {})).total, 0);
    assert.equal((await work.listMultiviewWorks(user, { taskId: 'mv05-source-task' })).works[0].status, 'waiting_source');
    assert.equal((await work.listMultiviewWorks(admin, { taskId: 'mv05-source-task' })).total, 0, 'Admin cannot list another owner works');
    await assert.rejects(work.getMultiviewWork(other, intent.id));
    checks.push('base_intent_unique_old_source_get_read_only_waiting_intent_hidden_owner_only_even_admin');

    const lease = await work.claimNextMultiviewWork(); assert.ok(lease);
    const sourceVersion = await multiviewSourceVersion(user, 'mv05-source-task');
    const info = { taskId: 'mv05-source-task', sourceVersion, width: 2, height: 2, duration: 2,
      timestamps: Array.from({ length: 8 }, (_, index) => index / 4) };
    const initialized = await work.initializeMultiviewWork(lease, info); assert.ok(initialized?.recipe);
    assert.equal(initialized.draftRevision, 1);
    assert.equal((await work.listMultiviewWorks(user, {})).total, 1);
    assert.equal(contract.parseMultiviewWorkRecipe({ ...initialized.recipe, slots: initialized.recipe.slots.map((slot, index) => index ? slot : { ...slot, frame: 99 }) }, info), null);
    const changedIds = { ...initialized.recipe, slots: initialized.recipe.slots.map(slot => ({ ...slot, id: randomUUID() })) };
    assert.equal(contract.multiviewWorkRecipesEqual(initialized.recipe, changedIds), true);
    const transient = contract.parseMultiviewWorkRecipe({ ...initialized.recipe, editing: initialized.recipe.slots[0].id, editorFrame: 7 }, info)!;
    assert.equal('editing' in transient, false);
    checks.push('intent_initialization_default_eight_frozen_source_recipe_bounds_and_applied_only_content');

    const removeBody = { action: 'remove', mutationId: randomUUID(), baseRevision: initialized.revision };
    const removed = await work.mutateMultiviewWork(user, intent.id, removeBody);
    assert.equal(removed.work.removed, true);
    assert.equal(removed.work.draftRevision, 1, 'Moving out must not create a new render recipe');
    assert.equal((await work.listMultiviewWorks(user, {})).total, 0);
    assert.equal((await work.listMultiviewWorks(user, { removed: true })).total, 1);
    assert.deepEqual((await work.mutateMultiviewWork(user, intent.id, removeBody)).receipt, removed.receipt);
    await assert.rejects(work.mutateMultiviewWork(user, intent.id, { ...removeBody, action: 'restore' }),
      (error: unknown) => error instanceof work.MultiviewWorkError && error.code === 'WORK_MUTATION_CONFLICT');
    await assert.rejects(work.mutateMultiviewWork(user, intent.id, { action: 'restore', mutationId: randomUUID(), baseRevision: initialized.revision }),
      (error: unknown) => error instanceof work.MultiviewWorkError && error.code === 'WORK_REVISION_CONFLICT');
    assert.equal((await work.readMultiviewWorkMutation(other, removeBody.mutationId)).state, 'not_found');
    const restored = await work.mutateMultiviewWork(user, intent.id, { action: 'restore', mutationId: randomUUID(), baseRevision: removed.work.revision });
    assert.equal(restored.work.removed, false);
    assert.equal(restored.work.draftRevision, 1);
    checks.push('remove_restore_cas_original_receipt_same_body_replay_conflict_and_actor_isolation');

    const failedMutation = randomUUID();
    await prisma.$executeRawUnsafe("CREATE TRIGGER mv05_isolated_audit_abort BEFORE INSERT ON OperationLog WHEN NEW.action = 'multiview_work_remove' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
    await assert.rejects(work.mutateMultiviewWork(user, intent.id, { action: 'remove', mutationId: failedMutation, baseRevision: restored.work.revision }));
    await prisma.$executeRawUnsafe('DROP TRIGGER mv05_isolated_audit_abort');
    assert.equal((await work.getMultiviewWork(user, intent.id)).revision, restored.work.revision);
    assert.equal((await work.getMultiviewWork(user, intent.id)).removed, false);
    assert.equal((await work.readMultiviewWorkMutation(user, failedMutation)).state, 'not_found');
    checks.push('audit_failure_rolls_back_work_and_mutation_together_unknown_receipt_never_replayed');

    await work.failMultiviewWork(initialized, 'synthetic resource wait', { resourceWait: true });
    const waiting = await prisma.multiviewWork.findUniqueOrThrow({ where: { id: intent.id } });
    assert.equal(waiting.attempts, 0); assert.equal(waiting.status, 'queued'); assert.equal(waiting.removed_at, null);
    const fakeManifest = { schema: 1 as const, sourceVersion, revision: 1, recipeHash: initialized.recipeHash!, width: 1, height: 1, frameCount: 8, files: [] };
    await assert.rejects(work.completeMultiviewWork(initialized, fakeManifest));
    assert.equal((await prisma.multiviewWork.findUniqueOrThrow({ where: { id: intent.id } })).ready_revision, null);
    checks.push('resource_wait_refunds_attempt_old_lease_and_partial_manifest_cannot_publish_ready');

    const token = await createSession('mv05-owner');
    const invokeList = async (ownerHeader: string, session: string) => {
      const headers = new Headers({ host: 'isolated.invalid', ...(session ? { Cookie: `${SESSION_COOKIE}=${session}` } : {}), 'x-app-session-user': ownerHeader });
      const request = new NextRequest('http://isolated.invalid/api/video/multiview/works', { headers });
      const store = { headers, cookies: new RequestCookies(headers) } as unknown as Parameters<typeof requestAsyncStorage.run>[0];
      return requestAsyncStorage.run(store, () => listRoute.GET(request));
    };
    assert.equal((await invokeList('mv05-other', token)).status, 409);
    assert.equal((await invokeList('mv05-owner', '')).status, 401);
    assert.equal((await invokeList('mv05-owner', token)).status, 200);
    // Header-only byte fixtures test descriptor/path safety, not PNG decoding
    // or completed rendering. All records/files remain inside this fresh DB/root.
    const privateDirectory = await work.multiviewWorkDirectory(user.id, intent.id, 1);
    mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    const roles = ['thumbnail', 'collage', 'zip', ...initialized.recipe.slots.map(slot => `frame-${slot.id}`)];
    const originals = new Map<string, Buffer>();
    const manifest: MultiviewWorkManifest = { schema: 1, sourceVersion, revision: 1, recipeHash: initialized.recipeHash!, width: 68, height: 40,
      frameCount: 8, files: roles.map((role): MultiviewWorkManifest['files'][number] => {
        const data = Buffer.concat([role === 'zip' ? Buffer.from([80, 75, 3, 4, 0, 0, 0, 0]) : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(`synthetic-${role}`)]);
        const file = `${role}.${role === 'zip' ? 'zip' : 'png'}`;
        originals.set(role, data); writeFileSync(path.join(privateDirectory, file), data, { mode: 0o600 });
        return { role: role as MultiviewWorkManifest['files'][number]['role'], file, mime: role === 'zip' ? 'application/zip' : 'image/png',
          bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), ...(role === 'zip' ? {} : { width: role === 'collage' ? 68 : 2, height: role === 'collage' ? 40 : 2 }) };
      }) };
    await prisma.multiviewWork.update({ where: { id: intent.id }, data: { ready_revision: 1, ready_recipe_json: JSON.stringify(initialized.recipe),
      ready_manifest_json: JSON.stringify(manifest), status: 'ready' } });
    const descriptor = await work.readMultiviewWorkFile(user, intent.id, 'collage', 1);
    const collagePath = path.join(privateDirectory, 'collage.png'), heldPath = path.join(privateDirectory, 'held-collage.png');
    renameSync(collagePath, heldPath); symlinkSync(path.join(privateDirectory, 'thumbnail.png'), collagePath);
    try {
      await assert.rejects(work.readMultiviewWorkFile(user, intent.id, 'collage', 1));
      const stream = descriptor.handle.createReadStream({ autoClose: true, start: 0, end: descriptor.bytes - 1 });
      const closed = new Promise<void>(resolve => stream.once('close', () => resolve()));
      const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      await closed;
      assert.deepEqual(Buffer.concat(chunks), originals.get('collage'), 'The already-authorized descriptor must not follow a replaced path');
      assert.equal(descriptor.handle.fd, -1);
    } finally {
      await descriptor.handle.close().catch(() => undefined);
      unlinkSync(collagePath); renameSync(heldPath, collagePath);
    }
    checks.push('private_descriptor_stays_bound_after_path_replacement_symlink_rejected_autoclose_header_only_fixture');
    const externalToken = await createSession('mv05-external');
    assert.equal((await invokeList('mv05-external', externalToken)).status, 403);
    await prisma.videoTask.update({ where: { id: 'mv05-source-task' }, data: { retention_status: 'user_deleted' } });
    await assert.rejects(work.getMultiviewWork(user, intent.id));
    assert.equal((await work.listMultiviewWorks(user, {})).total, 0);
    assert.equal(await prisma.creditLedger.count(), 0);
    assert.equal(await prisma.videoTask.count(), 1);
    checks.push('real_route_session_header_and_external_boundaries_source_revocation_zero_generation_or_credit_activity');
    completed = true;
  } finally {
    await prisma.$disconnect(); process.chdir(originalCwd);
    const receipt = path.join(directory, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ schema: 'mv05-storage-engineering.v1', synthetic: true, databasePath, checks, completed,
      productionWrites: 0, providerCalls: 0, browserRuns: 0, sourceDecode: false,
      scope: 'Real isolated Prisma/route/session/CAS/receipts; synthetic source identity/metadata, not render or production acceptance.' }, null, 2), { mode: 0o600 });
    console.log(`MV05 storage engineering receipt: ${receipt}`);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'MV05 isolated engineering failed'); process.exitCode = 1; });
