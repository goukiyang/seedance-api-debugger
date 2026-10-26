import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** MV17 isolated identity/CAS evidence. Source bytes are synthetic and never decoded. */
async function main() {
  const root = realpathSync(process.cwd()), scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'multiview-identity-'));
  assert.ok(realpathSync(directory).startsWith(realpathSync(scratch) + path.sep));
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined);
  process.env.DATABASE_URL = `file:${path.join(directory, 'synthetic.db')}`;
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  Object.assign(process.env, { NODE_ENV: 'test' });
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  if (!globalThis.crypto) Reflect.set(globalThis, 'crypto', webcrypto);
  globalThis.fetch = async () => { throw new Error('Network prohibited in MV17 isolated engineering'); };
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key]!;
  execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, stdio: 'pipe', timeout: 120000 });
  const require = createRequire(import.meta.url);
  const { requestAsyncStorage } = require('next/dist/client/components/request-async-storage.external') as typeof import('next/dist/client/components/request-async-storage.external');
  const { RequestCookies } = require('next/dist/compiled/@edge-runtime/cookies') as typeof import('next/dist/compiled/@edge-runtime/cookies');
  const { NextRequest } = await import('next/server');
  const { prisma } = await import('../src/lib/prisma');
  const { createSession } = await import('../src/lib/auth/session');
  const service = await import('../src/lib/video/multiview-works');
  const contract = await import('../src/lib/video/multiview-work-contract');
  const client = await import('../src/app/multiview/multiview-work-client');
  const source = await import('../src/lib/video/multiview');
  const collection = await import('../src/app/api/video/multiview/works/route');
  const item = await import('../src/app/api/video/multiview/works/[workId]/route');
  const mutations = await import('../src/app/api/video/multiview/works/mutations/[mutationId]/route');
  mkdirSync(path.join(directory, 'public', 'videos'), { recursive: true });
  mkdirSync(path.join(directory, 'public', 'uploads'), { recursive: true });
  writeFileSync(path.join(directory, 'public', 'videos', 'source.mp4'), 'synthetic source identity bytes', { mode: 0o600 });
  process.chdir(directory);
  const checks: string[] = [], evidencePath = path.join(directory, 'receipt.json');
  let completed = false;
  try {
    const tokens: Record<string, string> = {};
    for (const id of ['identity-owner', 'identity-other']) {
      await prisma.user.create({ data: { id, name: 'Synthetic actor', username: id, email: `${id}@isolated.invalid`,
        password_hash: 'synthetic-not-a-password', role: 'user', account_type: 'internal', feature_profile_id: 'internal_email_authorized' } });
      tokens[id] = await createSession(id);
    }
    const user = await service.multiviewWorkActor('identity-owner');
    await prisma.videoTask.create({ data: { id: 'identity-source', provider: 'seedance', model: 'synthetic', generation_mode: 'all_in_one_reference',
      prompt: 'synthetic', user_id: user.id, owner_user_id: user.id, local_status: 'succeeded', local_video_path: '/videos/source.mp4' } });
    const version = await source.multiviewSourceVersion(user, 'identity-source');
    const info = { taskId: 'identity-source', sourceVersion: version, width: 2, height: 2, duration: 2,
      timestamps: Array.from({ length: 8 }, (_, index) => index / 4) };
    // A valid metadata cache exercises the actual source stat, permission and
    // storage functions without invoking ffprobe on the synthetic byte file.
    const cache = path.join(directory, '.cache', 'multiview', version); mkdirSync(cache, { recursive: true });
    writeFileSync(path.join(cache, 'info.json'), JSON.stringify(info), { mode: 0o600 });
    const invoke = async (actor: string, method: 'GET' | 'POST' | 'PATCH', route: string, body?: unknown) => {
      const headers = new Headers({ Cookie: `session=${tokens[actor]}`, 'x-app-session-user': actor, Host: 'mv17-isolated.invalid',
        ...(body === undefined ? {} : { Origin: 'http://mv17-isolated.invalid', 'Content-Type': 'application/json' }) });
      const request = new NextRequest(`http://mv17-isolated.invalid/api/video/multiview/works${route}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify({ ...(body as Record<string, unknown>), protocol: contract.MULTIVIEW_SAVE_PROTOCOL }) }),
      });
      const store = { headers, cookies: new RequestCookies(headers) } as unknown as Parameters<typeof requestAsyncStorage.run>[0];
      const response = await requestAsyncStorage.run(store, () => route.startsWith('/mutations/')
        ? mutations.GET(request, { params: { mutationId: route.slice('/mutations/'.length) } })
        : route.startsWith('/') ? method === 'GET' ? item.GET(request, { params: { workId: route.slice(1) } })
          : item.PATCH(request, { params: { workId: route.slice(1) } })
          : method === 'GET' ? collection.GET(request) : collection.POST(request));
      return { status: response.status, body: await response.json() };
    };
    const initial = contract.parseMultiviewWorkRecipe({ ...contract.defaultMultiviewWorkRecipe(info), schema: 2 }, info)!;
    const created = await invoke(user.id, 'POST', '', { mutationId: randomUUID(), taskId: info.taskId, sourceVersion: version, recipe: initial });
    assert.equal(created.status, 200);
    const baseId: string = created.body.work.id;
    let current = await service.getMultiviewWork(user, baseId);
    const storeMap = new Map<string, string>();
    const storage = { getItem: (key: string) => storeMap.get(key) ?? null, setItem: (key: string, value: string) => { storeMap.set(key, value); } };
    assert.equal(await client.hasMultiviewWorkBaseline(storage, user.id, current), false);
    await client.retainMultiviewWorkBaseline(storage, user.id, current, () => true);
    assert.equal(await client.hasMultiviewWorkBaseline(storage, user.id, current), true);
    assert.equal(client.readMultiviewWorkBinding(storage, user.id, info.taskId)?.workId, baseId);
    assert.equal(client.readMultiviewWorkBinding(storage, 'identity-other', info.taskId), null);
    assert.equal(await client.hasMultiviewWorkBaseline(storage, user.id, { ...current, revision: current.revision + 1 }), false);
    assert.equal(await client.hasMultiviewWorkBaseline(storage, user.id, { ...current, sourceVersion: 'f'.repeat(64) }), false);
    checks.push('last_work_pointer_and_confirmed_baseline_are_owner_task_source_revision_content_scoped');

    const idsOnly = { ...initial, slots: initial.slots.map(slot => ({ ...slot, id: randomUUID() })) };
    assert.equal(contract.multiviewWorkContentSignature(initial, current.title), contract.multiviewWorkContentSignature(idsOnly, current.title));
    for (let index = 1; index <= 3; index++) {
      const recipe = { ...initial, layout: { ...initial.layout, gap: index } };
      const body = { mutationId: randomUUID(), action: 'save', baseRevision: current.revision, recipe, title: current.title };
      const saved = await invoke(user.id, 'PATCH', `/${baseId}`, body);
      assert.equal(saved.status, 200); assert.equal(saved.body.work.id, baseId);
      const after = await invoke(user.id, 'GET', `/mutations/${body.mutationId}`);
      assert.deepEqual(after.body, saved.body.receipt);
      assert.deepEqual((await invoke(user.id, 'PATCH', `/${baseId}`, body)).body.receipt, saved.body.receipt);
      current = saved.body.work;
      assert.equal(await prisma.multiviewWork.count(), 1);
    }
    checks.push('ordinary_applied_edits_save_same_work_id_and_original_mutation_query_replay_never_adds_works');

    const local = { ...current.recipe!, layout: { ...current.recipe!.layout, margin: 23 } };
    const prepared = await client.prepareMultiviewCurrentWorkSave({ workId: baseId, taskId: info.taskId, info, recipe: local,
      title: current.title, readFresh: async id => service.getMultiviewWork(user, id), isCurrent: () => true });
    assert.equal(prepared.work.id, baseId); assert.equal(prepared.work.revision, current.revision);
    local.layout.margin = 24;
    assert.equal(prepared.recipe.layout.margin, 23, 'Explicit save freezes selected content before the fresh read');
    const winner = await invoke(user.id, 'PATCH', `/${baseId}`, { mutationId: randomUUID(), action: 'save', baseRevision: current.revision,
      recipe: { ...current.recipe!, layout: { ...current.recipe!.layout, gap: 31 } }, title: current.title });
    assert.equal(winner.status, 200);
    const conflict = await invoke(user.id, 'PATCH', `/${baseId}`, { mutationId: randomUUID(), action: 'save', baseRevision: prepared.work.revision,
      recipe: prepared.recipe, title: prepared.title });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'WORK_REVISION_CONFLICT');
    const explicit = await client.prepareMultiviewCurrentWorkSave({ workId: baseId, taskId: info.taskId, info, recipe: prepared.recipe,
      title: prepared.title, readFresh: async id => service.getMultiviewWork(user, id), isCurrent: () => true });
    const resolved = await invoke(user.id, 'PATCH', `/${baseId}`, { mutationId: randomUUID(), action: 'save', baseRevision: explicit.work.revision,
      recipe: explicit.recipe, title: explicit.title });
    assert.equal(resolved.status, 200); assert.equal(resolved.body.work.id, baseId); assert.equal(await prisma.multiviewWork.count(), 1);
    await assert.rejects(client.prepareMultiviewCurrentWorkSave({ workId: baseId, taskId: info.taskId, info, recipe: prepared.recipe, title: current.title,
      readFresh: async () => ({ ...current, sourceVersion: 'a'.repeat(64) }), isCurrent: () => true }));
    checks.push('explicit_save_current_uses_fresh_original_revision_click_snapshot_and_still_rejects_intervening_cas_drift');

    const branchRequest = { mutationId: randomUUID(), action: 'branch', branchKey: randomUUID(), baseRevision: resolved.body.work.revision,
      recipe: resolved.body.work.recipe, title: resolved.body.work.title };
    const branched = await invoke(user.id, 'PATCH', `/${baseId}`, branchRequest);
    assert.equal(branched.status, 200); assert.notEqual(branched.body.work.id, baseId); assert.equal(branched.body.work.parentWorkId, baseId);
    assert.equal(await prisma.multiviewWork.count(), 2);
    assert.equal((await invoke(user.id, 'PATCH', `/${baseId}`, branchRequest)).body.work.id, branched.body.work.id);
    await prisma.multiviewWork.update({ where: { id: baseId }, data: { updated_at: new Date(Date.now() + 60000) } });
    const listed = await invoke(user.id, 'GET', `?taskId=${info.taskId}`);
    assert.equal(listed.status, 200); assert.equal(listed.body.preferredWorkId, branched.body.work.id);
    await client.retainMultiviewWorkBaseline(storage, user.id, branched.body.work, () => true);
    assert.equal(client.readMultiviewWorkBinding(storage, user.id, info.taskId)?.workId, branched.body.work.id);
    assert.equal((await invoke('identity-other', 'GET', `/${baseId}`)).status, 404);
    assert.equal(await prisma.multiviewWork.count(), 2);
    checks.push('only_explicit_branch_creates_second_id_and_latest_user_edit_preference_ignores_background_updated_at');

    const before = await prisma.multiviewWorkMutation.count();
    assert.equal((await invoke(user.id, 'GET', `/mutations/${randomUUID()}`)).body.state, 'not_found');
    assert.equal(await prisma.multiviewWorkMutation.count(), before);
    const noWrite = new Map(storeMap);
    await client.retainMultiviewWorkBaseline(storage, user.id, current, () => false);
    assert.deepEqual(storeMap, noWrite);
    assert.equal(await prisma.videoTask.count(), 1);
    assert.equal(await prisma.creditLedger.count(), 0);
    assert.equal(await prisma.providerApiRequest.count(), 0);
    checks.push('unknown_read_no_mutation_or_replay_late_owner_scope_does_not_write_pointer_zero_generation_or_charges');
    completed = true;
  } finally {
    await prisma.$disconnect(); process.chdir(root);
    writeFileSync(evidencePath, JSON.stringify({ kind: 'isolated-multiview-work-identity-engineering', completed, checks,
      production: false, generatedVideo: 0, upstreamRequests: 0, evidencePath }, null, 2), { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify({ completed, checks, evidencePath }) + '\n');
}
void main().catch(error => { process.stderr.write(String(error?.stack || error) + '\n'); process.exitCode = 1; });
