import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MULTIVIEW_FLOW_SOURCES } from './multiview-flow-fixture-inputs.mjs';
import { assertFreshFixtureFactory, openRealFixtureDatabase } from './fixtures/real-database-client';

async function main() {
  const root = realpathSync(process.cwd()), startedAt = Date.now();
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const hashes = () => Object.fromEntries(MULTIVIEW_FLOW_SOURCES.map(file => [file, hash(readFileSync(path.join(root, file)))]));
  const sourceSha256 = hashes();
  mkdirSync(path.join(root, '.role-tests'), { recursive: true, mode: 0o700 });
  const scratchBase = process.platform === 'linux' ? process.env.MULTIVIEW_PRIVATE_FIXTURE_ROOT : path.join(root, '.role-tests');
  assert.ok(scratchBase && path.isAbsolute(scratchBase) && realpathSync(scratchBase) === scratchBase);
  if (process.platform === 'linux') {
    assert.ok(scratchBase.startsWith('/data/video-api-debugger-engineering/'));
    assert.equal(statSync(scratchBase).mode & 0o777, 0o700);
    assert.equal(statSync(scratchBase).uid, process.getuid!());
  }
  const scratch = mkdtempSync(path.join(scratchBase, 'multiview-flow-'));
  const database = path.join(scratch, 'isolated.sqlite');
  execFileSync('python3', ['-c', `import sqlite3,pathlib,sys,json,subprocess
root=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2]); db=sqlite3.connect(target)
db.executescript((root/'prisma/migrations/20261016230000_multiview_works/migration.sql').read_text())
db.execute("INSERT INTO MultiviewWork(id,owner_id,source_task_id,updated_at) VALUES('old-work','old-owner','old-task',CURRENT_TIMESTAMP)")
db.execute("INSERT INTO MultiviewWorkMutation(id,actor_id,mutation_id,work_id,request_hash,action,receipt_json) VALUES('receipt','old-owner','original','old-work','hash','create','{}')")
before=db.execute('SELECT * FROM MultiviewWork').fetchall(); receipt=db.execute('SELECT * FROM MultiviewWorkMutation').fetchall(); db.commit()
assert json.loads(subprocess.check_output(['python3',str(root/'scripts/check-multiview-works-schema.py'),'--database',str(target)]))['state']=='legacy'
db.executescript((root/'prisma/migrations/20261026203000_multiview_flow/migration.sql').read_text())
assert db.execute('SELECT * FROM MultiviewWork').fetchone()[:len(before[0])]==before[0]
assert db.execute('SELECT * FROM MultiviewWorkMutation').fetchall()==receipt
try: db.execute("UPDATE MultiviewWork SET revision=revision+1 WHERE id='old-work'"); raise AssertionError('old writer accepted')
except sqlite3.IntegrityError as error: assert 'MULTIVIEW_FLOW_WRITER_REQUIRED' in str(error)
db.rollback(); db.close()
assert json.loads(subprocess.check_output(['python3',str(root/'scripts/check-multiview-works-schema.py'),'--database',str(target)]))['state']=='compatible'
`, root, path.join(scratch, 'legacy-migration.sqlite')]);
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${database}` });
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined);
  assertFreshFixtureFactory();
  globalThis.fetch = async () => { throw new Error('Network forbidden in isolated flow checks'); };
  execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')],
    { cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL }, stdio: 'pipe', timeout: 120000 });
  execFileSync('python3', ['-c', `import sqlite3,pathlib,sys
db=sqlite3.connect(sys.argv[1]); sql=pathlib.Path(sys.argv[2]).read_text(); db.executescript(sql[sql.index('CREATE TRIGGER'):]); db.close()
`, database, path.join(root, 'prisma/migrations/20261026203000_multiview_flow/migration.sql')]);
  const schema = JSON.parse(execFileSync('python3', [path.join(root, 'scripts/check-multiview-works-schema.py'), '--database', database], { encoding: 'utf8' }));
  assert.equal(schema.state, 'compatible'); assert.equal(schema.writes, 0);
  const fixture = await openRealFixtureDatabase(database);
  const { prisma } = await import('../src/lib/prisma');
  const require = createRequire(import.meta.url);
  const { requestAsyncStorage } = require('./fixtures/next-request-context') as typeof import('./fixtures/next-request-context');
  const { RequestCookies } = require('next/dist/compiled/@edge-runtime/cookies') as typeof import('next/dist/compiled/@edge-runtime/cookies');
  const { NextRequest } = await import('next/server');
  const { createSession, SESSION_COOKIE } = await import('../src/lib/auth/session');
  const { multiviewSourceRoute } = await import('../src/lib/video/multiview-source-api');
  const works = await import('../src/lib/video/multiview-works');
  const share = await import('../src/lib/video/multiview-share.server');
  const sources = await import('../src/lib/video/multiview-source.server');
  const media = await import('../src/lib/video/multiview');
  const contract = await import('../src/lib/video/multiview-work-contract');
  const { applyMultiviewFrameSettings } = await import('../src/app/multiview/multiview-frame-settings-client');
  const { multiviewOutputGroups } = await import('../src/lib/video/multiview-output-groups.server');
  const checks: string[] = ['additive_migration_preserves_old_rows_receipts_and_blocks_old_writer'];
  process.chdir(scratch);
  try {
    for (const id of ['flow-owner', 'flow-recipient', 'flow-outsider']) await prisma.user.create({ data: { id, username: id, name: id,
      email: `${id}@isolated.invalid`, password_hash: 'synthetic-not-a-password', account_type: 'internal', role: 'user', feature_profile_id: 'internal_email_authorized' } });
    const owner = await works.multiviewWorkActor('flow-owner'), recipient = await works.multiviewWorkActor('flow-recipient'), outsider = await works.multiviewWorkActor('flow-outsider');
    const tokens = new Map<string, string>();
    for (const actor of [owner, recipient, outsider]) tokens.set(actor.id, await createSession(actor.id));
    const sourceRequest = async (actor: string, shareId: string, method: 'GET' | 'HEAD', range?: string, expectedActor = actor) => {
      const headers = new Headers({ Cookie: `${SESSION_COOKIE}=${tokens.get(actor)}`, 'x-app-session-user': expectedActor,
        Host: 'flow-isolated.invalid', ...(range ? { Range: range } : {}) });
      const request = new NextRequest(`http://flow-isolated.invalid/api/video/multiview/shares/${shareId}/source/video`, { method, headers });
      const store = { headers, cookies: new RequestCookies(headers) } as unknown as Parameters<typeof requestAsyncStorage.run>[0];
      return requestAsyncStorage.run(store, () => multiviewSourceRoute(request, { kind: 'share', id: shareId }, 'video'));
    };
    mkdirSync(path.join(scratch, '.media/videos'), { recursive: true });
    mkdirSync(path.join(scratch, '.media/uploads'), { recursive: true });
    writeFileSync(path.join(scratch, '.media/videos/synthetic.mp4'), 'synthetic media bytes: storage/auth fixture, not video decoding', { mode: 0o600 });
    await prisma.videoTask.create({ data: { id: 'flow-source-task', owner_user_id: owner.id, user_id: owner.id, provider: 'seedance', model: 'synthetic',
      generation_mode: 'all_in_one_reference', prompt: 'DO_NOT_PROJECT_PRIVATE_PROMPT', local_status: 'succeeded', local_video_path: '/videos/synthetic.mp4' } });
    const version = await media.multiviewSourceVersion(owner, 'flow-source-task');
    const info = { taskId: 'flow-source-task', sourceVersion: version, width: 2, height: 2, duration: 2, timestamps: Array.from({ length: 8 }, (_, i) => i / 4) };
    const cache = path.join(scratch, '.cache/multiview', version); mkdirSync(cache, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(cache, 'info.json'), JSON.stringify(info), { mode: 0o600 });
    const initialRecipe = { ...contract.defaultMultiviewWorkRecipe(info), schema: 2 as const };
    initialRecipe.slots[0].locked = true;
    const recipe = contract.parseMultiviewWorkRecipe(initialRecipe, info)!;
    assert.equal(contract.parseMultiviewWorkRecipe(recipe, info)?.slots[0].locked, true);
    assert.notEqual(contract.multiviewWorkContentSignature(recipe), contract.multiviewWorkContentSignature({ ...recipe, slots: recipe.slots.map(slot => ({ ...slot, locked: false })) }));
    const applied = applyMultiviewFrameSettings({ ...recipe, editing: null }, info, { schema: 1, slots: [1, 2, 3].map(frame => ({ frame, name: '' })) });
    assert.equal(applied?.slots[0].frame, 0); assert.equal(applied?.slots[0].locked, true);
    checks.push('lock_recipe_signature_and_preset_preservation');
    const intent = await works.registerMultiviewWorkIntent(prisma, { ownerId: owner.id, taskId: info.taskId, projectId: null, videoCardId: null });
    assert.equal((await works.listMultiviewWorks(owner, { taskId: info.taskId })).total, 0);
    await assert.rejects(works.createMultiviewWork(owner, { mutationId: randomUUID(), taskId: info.taskId, sourceVersion: version, recipe }));
    await assert.rejects(prisma.multiviewWork.create({ data: { owner_id: owner.id, source_task_id: info.taskId } }));
    await assert.rejects(prisma.multiviewWork.update({ where: { id: intent.id }, data: { revision: { increment: 1 } } }));
    const first = await works.createMultiviewWork(owner, { protocol: contract.MULTIVIEW_SAVE_PROTOCOL, mutationId: randomUUID(), taskId: info.taskId,
      sourceVersion: version, recipe, branchKey: randomUUID(), title: 'Explicit branch' });
    assert.equal(await prisma.multiviewWork.count({ where: { save_state: 'saved' } }), 1);
    assert.notEqual(first.work.id, intent.id);
    checks.push('old_writer_rejected_intent_not_saved_first_branch_one_formal_work');
    const legacyBody = { mutationId: randomUUID(), taskId: info.taskId, sourceVersion: version, recipe: { ...recipe, schema: 1 } };
    const stable = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    const legacyReceipt = { ...first.receipt, mutationId: legacyBody.mutationId };
    await prisma.multiviewWorkMutation.create({ data: { actor_id: owner.id, mutation_id: legacyBody.mutationId, work_id: first.work.id, action: 'create',
      request_hash: hash(stable({ action: 'create', workId: null, input: legacyBody })), receipt_json: JSON.stringify(legacyReceipt) } });
    assert.deepEqual((await works.createMultiviewWork(owner, legacyBody)).receipt, legacyReceipt);
    assert.equal(await prisma.multiviewWork.count({ where: { save_state: 'saved' } }), 1);
    checks.push('legacy_original_receipt_replayed_before_new_protocol_no_write');
    const dir = await works.multiviewWorkDirectory(owner.id, first.work.id, 1); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const roles = ['thumbnail', 'collage', 'zip', ...recipe.slots.map(slot => `frame-${slot.id}`)];
    const sharp = (await import('../src/lib/media/sharp')).default;
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00ff00' } }).png().toBuffer();
    const manifest = { schema: 1, sourceVersion: version, revision: 1, recipeHash: works.multiviewWorkRecipeHash(recipe), width: 8, height: 4, frameCount: 8,
      files: roles.map(role => { const bytes = role === 'zip' ? Buffer.from('PK\x03\x04synthetic archive') : image, file = `${role}.${role === 'zip' ? 'zip' : 'png'}`;
        writeFileSync(path.join(dir, file), bytes, { mode: 0o600 });
        return { role, file, bytes: bytes.length, sha256: hash(bytes), mime: role === 'zip' ? 'application/zip' : 'image/png', ...(role === 'zip' ? {} : { width: 2, height: 2 }) }; }) };
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    await prisma.multiviewWork.update({ where: { id: first.work.id }, data: { ready_revision: 1, ready_recipe_json: JSON.stringify(recipe), ready_manifest_json: JSON.stringify(manifest), status: 'ready' } });
    const copyInput = { protocol: contract.MULTIVIEW_SAVE_PROTOCOL, mutationId: randomUUID(), action: 'copy', workId: first.work.id, revision: 1, recipients: [recipient.id] };
    const copied = await share.mutateMultiviewShare(owner, copyInput);
    assert.equal(copied.state, 'committed'); assert.ok(copied.shareId);
    assert.deepEqual(await share.mutateMultiviewShare(owner, copyInput), copied);
    assert.equal(await prisma.notification.count(), 0);
    await assert.rejects(share.readMultiviewShare(outsider, copied.shareId));
    const dto = await share.readMultiviewShare(recipient, copied.shareId);
    assert.equal(JSON.stringify(dto).includes('DO_NOT_PROJECT'), false); assert.equal('owner_id' in dto, false);
    const range = await sourceRequest(recipient.id, copied.shareId, 'GET', 'bytes=0-8');
    assert.equal(range.status, 206); assert.equal(await range.text(), 'synthetic');
    assert.equal(range.headers.get('cache-control'), 'private, no-store');
    const head = await sourceRequest(recipient.id, copied.shareId, 'HEAD');
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0); assert.ok(Number(head.headers.get('content-length')) > 9);
    assert.equal((await sourceRequest(outsider.id, copied.shareId, 'HEAD')).status, 403);
    assert.equal((await sourceRequest(recipient.id, copied.shareId, 'GET', undefined, owner.id)).status, 409);
    checks.push('actual_source_route_head_range_owner_boundary_no_store_and_denied_outsider');
    const sentInput = { ...copyInput, action: 'send', mutationId: randomUUID() };
    const sent = await share.mutateMultiviewShare(owner, sentInput);
    assert.equal(sent.state, 'committed'); assert.deepEqual(await share.mutateMultiviewShare(owner, sentInput), sent);
    assert.equal(await prisma.notification.count(), 1);
    checks.push('copy_without_notification_send_atomic_replay_and_minimal_authorized_projection');
    const modified = { ...recipe, slots: recipe.slots.map((slot, index) => index === 1 ? { ...slot, frame: 2 } : slot) };
    const saved = await works.mutateMultiviewWork(owner, first.work.id, { protocol: contract.MULTIVIEW_SAVE_PROTOCOL, mutationId: randomUUID(), action: 'save',
      baseRevision: first.work.revision, recipe: modified, title: 'New title' });
    assert.equal(saved.work.draftRevision, 2);
    assert.equal((await share.readMultiviewShare(recipient, copied.shareId)).title, 'Explicit branch');
    assert.deepEqual((await share.readMultiviewShareFile(recipient, copied.shareId, 'collage')).bytes, image);
    const branchInput = { protocol: contract.MULTIVIEW_SAVE_PROTOCOL, mutationId: randomUUID(), action: 'branch', shareId: copied.shareId, recipe: modified, title: 'My independent copy' };
    const branched = await share.mutateMultiviewShare(recipient, branchInput);
    assert.equal(branched.state, 'committed');
    const independent = await works.getMultiviewWork(recipient, branched.workId);
    assert.ok(independent.sourceId); assert.equal(independent.projectId, null); assert.equal(independent.sourceTaskId, info.taskId);
    await assert.rejects(works.assertMultiviewWorkSource(recipient, info.taskId));
    await share.mutateMultiviewShare(owner, { protocol: contract.MULTIVIEW_SAVE_PROTOCOL, mutationId: randomUUID(), action: 'revoke', shareId: copied.shareId });
    await assert.rejects(share.readMultiviewShare(recipient, copied.shareId));
    assert.equal((await sourceRequest(recipient.id, copied.shareId, 'HEAD')).status, 404);
    assert.equal((await media.multiviewSourceFile(recipient, info.taskId, version, { kind: 'work', id: independent.id })).info.sourceVersion, version);
    assert.equal((await prisma.multiviewSource.findUniqueOrThrow({ where: { id: independent.sourceId! } })).can_reshare, false);
    checks.push('immutable_old_share_revision_and_independent_copy_survives_revocation_without_task_permission');
    let calls = 0, revocations = 0;
    const restoreTransaction = fixture.interceptTransactions(async () => {
      if (++calls === 2) {
        const revoked = await prisma.multiviewShare.update({ where: { id: sent.shareId }, data: { revoked_at: new Date() } });
        assert.ok(revoked.revoked_at, 'Race hook must persist the actual revocation'); revocations++;
      }
    });
    let raced;
    try { raced = await share.mutateMultiviewShare(recipient, { ...branchInput, mutationId: randomUUID(), shareId: sent.shareId }); }
    finally { restoreTransaction(); }
    assert.ok(calls >= 2, 'Race hook must intercept the claim and fresh commit');
    assert.equal(revocations, 1, 'Race hook must revoke exactly once');
    assert.ok((await prisma.multiviewShare.findUniqueOrThrow({ where: { id: sent.shareId } })).revoked_at, 'Race hook must remain visible in actual SQLite');
    assert.equal(raced.state, 'rejected'); assert.equal(raced.notCommitted, true);
    assert.equal(await prisma.multiviewWork.count({ where: { owner_id: recipient.id } }), 1);
    assert.equal(calls, 3, 'Race hook must observe claim, denied commit and durable rejection');
    await fixture.verify();
    checks.push('revocation_during_copy_rejected_at_fresh_commit_without_orphan_work');
    const exhaustedInput = { ...branchInput, mutationId: randomUUID() };
    await prisma.multiviewShareMutation.create({ data: { id: randomUUID(), actor_id: recipient.id, mutation_id: exhaustedInput.mutationId,
      request_hash: hash(stable(exhaustedInput)), request_json: stable(exhaustedInput), action: 'branch', state: 'preparing', attempts: 3, lease_until: new Date(0) } });
    assert.equal((await share.readMultiviewShareOperation(recipient, exhaustedInput.mutationId)).canResume, true);
    const exhausted = await share.resumeMultiviewShareOperation(recipient, exhaustedInput.mutationId);
    assert.equal(exhausted.state, 'rejected'); assert.equal(exhausted.notCommitted, true);
    assert.equal((await prisma.multiviewShareMutation.findUniqueOrThrow({ where: { actor_id_mutation_id: { actor_id: recipient.id, mutation_id: exhaustedInput.mutationId } } })).attempts, 3);
    assert.equal(await prisma.multiviewWork.count({ where: { owner_id: recipient.id } }), 1);
    checks.push('exhausted_copy_original_resume_fences_late_attempt_without_fourth_copy');
    process.env.MULTIVIEW_FLOW_READ_ONLY = '1';
    assert.deepEqual(await share.readMultiviewShareOperation(recipient, branchInput.mutationId), branched);
    assert.equal((await works.getMultiviewWork(recipient, independent.id)).sourceState, 'current');
    await assert.rejects(works.mutateMultiviewWork(recipient, independent.id, { protocol: contract.MULTIVIEW_SAVE_PROTOCOL, mutationId: randomUUID(), action: 'remove', baseRevision: independent.revision }));
    delete process.env.MULTIVIEW_FLOW_READ_ONLY;
    checks.push('compatibility_read_only_mode_keeps_new_source_and_original_receipts');
    if (process.platform === 'linux') {
      const backups = path.join(scratch, 'backups'); mkdirSync(backups, { mode: 0o700 }); chmodSync(backups, 0o700);
      const backup = path.join(backups, 'flow');
      const result = JSON.parse(execFileSync('python3', [path.join(root, 'scripts/backup-multiview-works.py'), '--database', database,
        '--source-root', path.resolve(dir, '../../..'), '--private-source-root', await sources.multiviewSourceRoot(),
        '--recipe-root', path.join(scratch, 'recipes'), '--uploads-root', path.join(scratch, '.media/uploads'),
        '--destination', backup, '--non-production'], { encoding: 'utf8' }));
      assert.equal(result.complete, true);
      const verified = JSON.parse(execFileSync('python3', [path.join(root, 'scripts/backup-multiview-works.py'), '--verify-backup', backup, '--non-production'], { encoding: 'utf8' }));
      assert.equal(verified.verified, true);
      const mapping = JSON.parse(readFileSync(path.join(backup, 'mapping.json'), 'utf8'));
      assert.ok(mapping.sources.length >= 2); assert.equal(mapping.works.length, 1);
      checks.push('backup_copies_private_sources_immutable_share_and_verifies_isolated_snapshot');
    }
    const outputs: Array<{ role: string; state: string; assetId: string; sha256: string }> = [];
    for (const [index, role] of Array.from(['collage', ...recipe.slots.map(slot => `frame-${slot.id}`)].entries())) {
      const asset = await prisma.asset.create({ data: { owner_id: owner.id, hash: hash(role), type: 'image', status: 'active',
        original_url: `/uploads/${role}.png`, file_name: `${role}.png`, file_size: image.length, mime_type: 'image/png', metadata_json: JSON.stringify({ source: index === 1 ? 'ordinary-upload' : 'multiview-output' }) } });
      outputs.push({ role, state: 'registered', assetId: asset.id, sha256: asset.hash! });
    }
    await prisma.platformSetting.create({ data: { key: `multiview_output_registration_v1:receipt:${first.work.id}:1`, updated_by: owner.id,
      value_json: JSON.stringify({ schema: 1, state: 'registered', ownerId: owner.id, workId: first.work.id, readyRevision: 1, outputs }) } });
    await prisma.platformSetting.create({ data: { key: `multiview_output_registration_v1:receipt:${first.work.id}:2`, updated_by: owner.id,
      value_json: JSON.stringify({ schema: 1, state: 'registered', ownerId: owner.id, workId: first.work.id, readyRevision: 2, outputs: outputs.map((entry, index) => index === 2 ? { ...entry, state: 'unavailable' } : entry) }) } });
    let groups = await multiviewOutputGroups(owner);
    assert.equal(groups.groups.length, 1); assert.equal(groups.groups[0].revision, 1);
    assert.equal(groups.dedicatedIds.has(outputs[1].assetId), false);
    groups = await multiviewOutputGroups(owner, [outputs[2].assetId]);
    assert.equal(groups.groups[0].missing, 1); assert.equal(groups.groups[0].assets.some(asset => asset.id === outputs[2].assetId), false);
    checks.push('complete_group_revision_atomic_partial_fallback_hidden_members_and_shared_upload_preserved');
    await prisma.multiviewWork.update({ where: { id: intent.id }, data: { source_version: version, source_info_json: JSON.stringify(info),
      draft_revision: 1, recipe_json: JSON.stringify(recipe), recipe_hash: works.multiviewWorkRecipeHash(recipe) } });
    const explicitBase = await works.createMultiviewWork(owner, { protocol: contract.MULTIVIEW_SAVE_PROTOCOL, mutationId: randomUUID(),
      taskId: info.taskId, sourceVersion: version });
    assert.equal(explicitBase.work.id, intent.id); assert.equal(explicitBase.work.draftRevision, 2);
    assert.equal(explicitBase.work.saveState, 'saved');
    assert.equal(works.multiviewWorkRecipeHash(explicitBase.work.recipe!), (await prisma.multiviewWork.findUniqueOrThrow({ where: { id: intent.id } })).recipe_hash);
    checks.push('first_explicit_save_advances_intent_output_revision_and_uses_canonical_recipe');
    assert.deepEqual(hashes(), sourceSha256);
    await fixture.verify();
    const receipt = process.argv[2] || path.join(root, '.role-tests', `multiview-flow-${randomUUID()}.json`);
    assert.ok(path.resolve(receipt).startsWith(path.join(root, '.role-tests') + path.sep));
    writeFileSync(receipt, JSON.stringify({ schema: 'multiview-flow-engineering.v1', completed: true, synthetic: true,
      runId: process.env.IMAGE_RECOVERY_GATE_RUN_ID, candidateRoot: root, startedAt, finishedAt: Date.now(),
      applicationDatabaseOpened: false, productionWrites: 0, paidRequests: 0, browserRuns: 0, forbiddenCalls: 0,
      sourceSha256, checks }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log('Multiview flow engineering receipt: ' + receipt);
  } finally { await fixture.close(); process.chdir(root); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
