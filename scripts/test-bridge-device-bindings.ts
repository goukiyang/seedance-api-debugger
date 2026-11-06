import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import type { RequestStore } from 'next/dist/client/components/request-async-storage.external';

async function main() {
  // Only a freshly created synthetic database is used, irrespective of the caller's environment.
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'sd2-binding-test-')));
  process.env.DATABASE_URL = 'file:' + path.join(scratch, 'synthetic.db');
  process.env.SESSION_SECRET = 'device-binding-isolated-test-secret';
  Object.assign(process.env, { NODE_ENV: 'test', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' });
  Object.assign(globalThis, { AsyncLocalStorage });
  const schema = path.join(scratch, 'schema.prisma');
  copyFileSync(path.resolve('prisma/schema.prisma'), schema);
  execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--schema', schema, '--skip-generate'], {
    cwd: scratch, env: process.env, stdio: 'pipe', timeout: 120_000,
  });
  // Next replaces this build-only marker in server bundles; standalone route tests use its empty server meaning.
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  loader._load = (id, ...args) => id === 'server-only' ? {} : originalLoad(id, ...args);
  const { prisma } = await import('../src/lib/prisma');
  const { createSession } = await import('../src/lib/auth/session');
  const { requestAsyncStorage } = await import('next/dist/client/components/request-async-storage.external');
  const { RequestCookies } = await import('next/dist/server/web/spec-extension/cookies');
  const { NextRequest } = await import('next/server');
  const reportRoute = await import('../src/app/api/bridge/devices/binding/route');
  const adoptRoute = await import('../src/app/api/bridge/devices/binding/adopt/route');
  const listRoute = await import('../src/app/api/bridge/devices/bindings/route');
  const patchRoute = await import('../src/app/api/bridge/devices/bindings/[deviceId]/route');
  const legacyRoute = await import('../src/app/api/bridge/devices/route');
  const statusRoute = await import('../src/app/api/bridge/devices/status/route');
  const { BRIDGE_DEVICES_PREF_KEY } = await import('../src/lib/bridge/devices');
  const cookies = new Map<string, string>();
  const cases: string[] = [];
  const report = (deviceId: string, editedAt = 100) => ({
    deviceId, machineName: '办公室 Mac', profileName: '工作', platform: 'mac', extVersion: '0.3.1',
    chromeEmail: 'alice@example.com', shared: false, editedAt,
    tools: {
      midjourney: { accept: true, login: 'ok', account: 'alice_mj', accountKey: 'abc123000001', tabOpen: true, checkedAt: 500, dailyCap: 50 },
      chatgpt: { accept: true, login: 'none', account: 'alice@example.com', accountKey: 'abc123000002', tabOpen: false, checkedAt: 500 },
      jimeng: { accept: false, login: 'unknown', account: '', accountKey: '', tabOpen: false, checkedAt: 0 },
    },
  });
  async function call(actor: string | null, method: string, suffix: string, body?: unknown, shell = true) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (actor) headers.set('Cookie', 'session=' + cookies.get(actor));
    if (shell) headers.set('X-SD2B-Shell', '0.3.1');
    const request = new NextRequest('http://localhost/api/bridge/devices' + suffix, {
      method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const store = { headers, cookies: new RequestCookies(headers) } as unknown as RequestStore;
    const response = await requestAsyncStorage.run(store, async () => {
      if (method === 'PUT') return reportRoute.PUT(request);
      if (suffix === '/binding/adopt') return adoptRoute.POST(request);
      if (suffix === '/status') return statusRoute.POST(request);
      if (method === 'PATCH') return patchRoute.PATCH(request, { params: { deviceId: decodeURIComponent(suffix.split('/').pop()!) } });
      if (!suffix) return legacyRoute.GET();
      return listRoute.GET(request);
    });
    return { status: response.status, data: await response.json() };
  }
  async function getStored(userId: string) {
    const row = await prisma.userPreference.findUniqueOrThrow({ where: { user_id_key: { user_id: userId, key: BRIDGE_DEVICES_PREF_KEY } } });
    return JSON.parse(row.value_json) as Array<Record<string, any>>;
  }
  async function store(userId: string, devices: Array<Record<string, any>>) {
    await prisma.userPreference.upsert({
      where: { user_id_key: { user_id: userId, key: BRIDGE_DEVICES_PREF_KEY } },
      update: { value_json: JSON.stringify(devices) },
      create: { user_id: userId, key: BRIDGE_DEVICES_PREF_KEY, value_json: JSON.stringify(devices) },
    });
  }
  try {
    for (const id of ['owner', 'other', 'admin', 'full']) {
      await prisma.user.create({ data: { id, name: id === 'admin' ? '管理员甲' : id, username: id,
        email: id + '@example.test', avatar_url: `https://example.test/${id}.png`, password_hash: 'synthetic-unused', role: id === 'admin' ? 'admin' : 'user' } });
      cookies.set(id, await createSession(id));
    }
    assert.equal((await call(null, 'PUT', '/binding', report('first'))).status, 401);
    assert.equal((await call('owner', 'PUT', '/binding', report('first'), false)).status, 403);
    assert.equal((await call('owner', 'POST', '/binding/adopt', { deviceId: 'a', fromDeviceId: 'b' }, false)).status, 403);
    assert.equal((await call('owner', 'PUT', '/binding', '{broken')).status, 400);
    cases.push('cookie auth, shell header and JSON boundary');

    const initial = await call('owner', 'PUT', '/binding', { ...report('first'), disabled: true, archived: true, cookie: 'must-not-persist', editedByUserId: 'other' });
    assert.equal(initial.status, 200);
    assert.equal(initial.data.binding.chromeEmail, 'a***@example.com');
    assert.equal(initial.data.binding.tools.chatgpt.account, 'a***@example.com');
    assert.equal(initial.data.binding.disabled, false);
    assert.equal(initial.data.binding.archived, false);
    assert.equal(initial.data.binding.editedBy, 'owner');
    assert.equal((await getStored('owner'))[0].cookie, undefined);
    assert.equal((await getStored('owner'))[0].editedByUserId, 'owner');
    assert.equal(initial.data.binding.editedByUserId, undefined);
    assert.equal(initial.data.mine[0].tools.midjourney.accountKey, 'abc123000001');
    const tie = report('first');
    tie.machineName = '不应覆盖'; tie.tools.midjourney.login = 'blocked';
    const tied = await call('owner', 'PUT', '/binding', tie);
    assert.equal(tied.data.binding.machineName, '办公室 Mac');
    assert.equal(tied.data.binding.tools.midjourney.login, 'blocked');
    const newer = await call('owner', 'PUT', '/binding', { ...report('first', 101), machineName: '新机器' });
    assert.equal(newer.data.binding.machineName, '新机器');
    cases.push('initial, equal and newer timestamps; plugin facts and masking; unknown fields dropped');

    const patch = await call('admin', 'PATCH', '/bindings/first', {
      machineName: '管理命名', shared: true, tools: { midjourney: { accept: false, dailyCap: 17 } },
      disabled: true, disabledReason: '维护中',
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.data.binding.editedBy, '管理员甲');
    const editorAfterPatch = (await call('admin', 'GET', '/bindings?scope=all')).data.bindings.find((binding: { deviceId: string }) => binding.deviceId === 'first').editor;
    assert.equal(editorAfterPatch.id, 'admin');
    assert.equal(editorAfterPatch.avatar_url, 'https://example.test/admin.png');
    assert.deepEqual(Object.keys(editorAfterPatch).sort(), ['avatar_url', 'id', 'name']);
    const staleReport = report('first', 99);
    staleReport.tools.midjourney.login = 'none';
    const merged = await call('owner', 'PUT', '/binding', { ...staleReport, platform: 'win', chromeEmail: 'bob@example.com', disabled: false });
    assert.equal(merged.data.binding.machineName, '管理命名');
    assert.equal(merged.data.binding.tools.midjourney.accept, false);
    assert.equal(merged.data.binding.tools.midjourney.dailyCap, 17);
    assert.equal(merged.data.binding.tools.midjourney.login, 'none');
    assert.equal(merged.data.binding.platform, 'win');
    assert.equal(merged.data.binding.chromeEmail, 'b***@example.com');
    assert.equal(merged.data.binding.disabled, true);
    assert.equal(merged.data.binding.disabledReason, '维护中');
    assert.equal(merged.data.binding.editedAt, patch.data.binding.editedAt);
    assert.equal((await getStored('owner')).find(device => device.deviceId === 'first')!.editedByUserId, 'admin');
    const userLater = await call('owner', 'PUT', '/binding', { ...report('first', patch.data.binding.editedAt + 1), machineName: '本人后改' });
    assert.equal(userLater.data.binding.machineName, '本人后改');
    assert.equal(userLater.data.binding.disabled, true);
    const audit = await prisma.operationLog.findFirstOrThrow({ where: { action: 'bridge_binding_edit', target_id: 'first' } });
    assert.equal(JSON.parse(audit.detail!).before.machineName, '新机器');
    assert.equal(JSON.parse(audit.detail!).after.machineName, '管理命名');
    cases.push('admin edit wins stale heartbeat, later user edit and permanent admin flags, atomic audit');

    assert.equal((await call('other', 'PUT', '/binding', report('first'))).status, 403);
    assert.equal((await call('other', 'PATCH', '/bindings/first', { machineName: '冒用' })).status, 403);
    for (const field of ['disabled', 'archived', 'disabledReason', 'ownerUserId']) {
      assert.equal((await call('owner', 'PATCH', '/bindings/first', { [field]: true })).status, 403);
    }
    for (const payload of [{ tools: { midjourney: { login: 'ok' } } }, { chromeEmail: 'x@example.com' }, { platform: 'mac' },
      { tools: { chatgpt: { accountKey: 'fake' } } }, { sites: { midjourney: { loggedIn: true } } }]) {
      assert.equal((await call('admin', 'PATCH', '/bindings/first', payload)).status, 400);
    }
    assert.equal((await call('owner', 'GET', '/bindings?scope=all')).status, 403);
    const all = await call('admin', 'GET', '/bindings?scope=all');
    assert.equal(all.status, 200); assert.equal(all.data.bindings[0].owner.id, 'owner'); assert.equal(all.data.bindings[0].online, true);
    assert.equal((await call('other', 'GET', '/bindings')).data.bindings.length, 0);
    cases.push('spoofing, admin-only fields, immutable login fields and list scope');

    const clipped = await call('owner', 'PUT', '/binding', {
      ...report('validation'), machineName: 'M'.repeat(60), profileName: 'P'.repeat(60),
      tools: { midjourney: { accept: true, login: 'bad', account: 'A'.repeat(90), dailyCap: 600, token: 'discard' } },
    });
    assert.equal(clipped.data.binding.machineName.length, 40); assert.equal(clipped.data.binding.profileName.length, 40);
    assert.equal(clipped.data.binding.tools.midjourney.account.length, 80);
    assert.equal(clipped.data.binding.tools.midjourney.login, 'unknown'); assert.equal(clipped.data.binding.tools.midjourney.dailyCap, 500);
    assert.equal(clipped.data.binding.tools.midjourney.token, undefined);
    const clippedPatch = await call('admin', 'PATCH', '/bindings/validation', { disabledReason: 'R'.repeat(220), tools: { midjourney: { dailyCap: -10 } } });
    assert.equal(clippedPatch.data.binding.disabledReason.length, 200);
    assert.equal(clippedPatch.data.binding.tools.midjourney.dailyCap, 0);
    cases.push('field caps, enum, daily cap and nested whitelist');

    await call('owner', 'PUT', '/binding', { ...report('old'), machineName: '接管测试', shared: true });
    await call('owner', 'PUT', '/binding', { ...report('new'), machineName: '接管测试' });
    await call('owner', 'PUT', '/binding', { ...report('recent'), machineName: '接管测试' });
    let devices = await getStored('owner');
    devices = devices.map(d => d.deviceId === 'old' ? { ...d, lastSeenAt: Date.now() - 11 * 60_000, lastSeen: new Date(Date.now() - 11 * 60_000).toISOString() } : d);
    await store('owner', devices);
    const possible = await call('owner', 'PUT', '/binding', { ...report('new'), machineName: '接管测试' });
    assert.deepEqual(possible.data.possibleSameAs.map((d: { deviceId: string }) => d.deviceId), ['old']);
    assert.equal((await call('other', 'POST', '/binding/adopt', { deviceId: 'new', fromDeviceId: 'old' })).status, 403);
    const adopted = await call('owner', 'POST', '/binding/adopt', { deviceId: 'new', fromDeviceId: 'old' });
    assert.equal((await getStored('owner')).find(device => device.deviceId === 'new')!.editedByUserId, 'owner');
    assert.equal(adopted.status, 200); assert.equal(adopted.data.binding.shared, true);
    assert.equal(adopted.data.binding.tools.midjourney.login, 'ok');
    assert.equal((await getStored('owner')).find(d => d.deviceId === 'old')!.archived, true);
    assert.equal((await call('owner', 'GET', '/bindings')).data.bindings.some((d: { deviceId: string }) => d.deviceId === 'old'), false);
    assert.equal((await call('owner', 'GET', '/bindings?includeArchived=1')).data.bindings.some((d: { deviceId: string }) => d.deviceId === 'old'), true);
    assert.equal((await call('owner', 'POST', '/binding/adopt', { deviceId: 'new', fromDeviceId: 'old' })).status, 409);
    const archivedHeartbeat = await call('owner', 'PUT', '/binding', { ...report('old'), machineName: '接管测试' });
    assert.equal(archivedHeartbeat.data.binding.archived, true);
    cases.push('possibleSameAs, ownership, adopt, archive filtering and no heartbeat revival');

    const moved = await call('admin', 'PATCH', '/bindings/new', { ownerUserId: 'other' });
    assert.equal(moved.status, 200);
    assert.equal((await getStored('owner')).some(d => d.deviceId === 'new'), false);
    assert.equal((await getStored('other')).filter(d => d.deviceId === 'new').length, 1);
    assert.equal((await getStored('other')).find(d => d.deviceId === 'new')!.editedByUserId, 'admin');
    const transferred = (await call('admin', 'GET', '/bindings?scope=all')).data.bindings.find((binding: { deviceId: string }) => binding.deviceId === 'new');
    assert.equal(transferred.owner.id, 'other');
    assert.equal(transferred.editor.id, 'admin');
    assert.equal(transferred.editor.avatar_url, 'https://example.test/admin.png');
    cases.push('trusted editor identity, live photo, stale heartbeat preservation and owner/editor separation');
    assert.equal((await call('owner', 'PUT', '/binding', report('new'))).status, 403);
    assert.equal((await call('owner', 'POST', '/status', { deviceId: 'new' })).status, 403);
    const transferLog = await prisma.operationLog.findFirstOrThrow({ where: { action: 'bridge_binding_edit', target_id: 'new' } });
    assert.equal(JSON.parse(transferLog.detail!).before.ownerUserId, 'owner');
    assert.equal(JSON.parse(transferLog.detail!).after.ownerUserId, 'other');
    cases.push('owner transfer commits both records and audit, old owner cannot reclaim through either heartbeat');

    const oldFormat = { deviceId: 'legacy', deviceName: '原机器名', chromeProfile: '原资料', extVersion: '0.2.9',
      sites: { midjourney: { loggedIn: true, account: 'legacy_mj' } } };
    assert.equal((await call('owner', 'POST', '/status', oldFormat)).status, 200);
    const oldGet = (await call('owner', 'GET', '')).data;
    const legacy = oldGet.devices.find((d: { deviceId: string }) => d.deviceId === 'legacy');
    assert.equal(legacy.deviceName, '原机器名'); assert.equal(legacy.chromeProfile, '原资料');
    assert.equal(legacy.sites.midjourney.loggedIn, true); assert.equal(legacy.stale, false); assert.equal(oldGet.stale_after_ms, 600_000);
    await call('owner', 'PUT', '/binding', report('legacy'));
    await call('admin', 'PATCH', '/bindings/legacy', { machineName: '新绑定名', disabled: true, tools: { midjourney: { dailyCap: 9 } } });
    await Promise.all([
      call('owner', 'POST', '/status', oldFormat),
      call('admin', 'PATCH', '/bindings/first', { profileName: '并发保留' }),
      call('owner', 'PUT', '/binding', report('concurrent-new')),
    ]);
    const retained = await getStored('owner'), legacyAfter = retained.find(d => d.deviceId === 'legacy')!;
    assert.equal(legacyAfter.machineName, '新绑定名'); assert.equal(legacyAfter.disabled, true); assert.equal(legacyAfter.tools.midjourney.dailyCap, 9);
    assert.equal(legacyAfter.deviceName, '原机器名');
    assert.equal(retained.find(d => d.deviceId === 'first')!.profileName, '并发保留');
    assert.ok(retained.some(d => d.deviceId === 'concurrent-new'));
    cases.push('legacy GET/status contract and transaction overlap preserve all binding fields and sibling devices');

    const sample = retained.find(d => d.deviceId === 'concurrent-new')!;
    await store('full', Array.from({ length: 50 }, (_, i) => ({ ...sample, deviceId: 'full-' + i })));
    assert.equal((await call('full', 'PUT', '/binding', report('overflow'))).status, 409);
    assert.equal((await call('full', 'POST', '/status', { deviceId: 'overflow' })).status, 409);
    assert.equal((await call('full', 'POST', '/status', { deviceId: 'full-0' })).status, 200);
    assert.equal((await getStored('full')).length, 50);
    const logsBefore = await prisma.operationLog.count();
    assert.equal((await call('admin', 'PATCH', '/bindings/first', { ownerUserId: 'full' })).status, 409);
    assert.ok((await getStored('owner')).some(d => d.deviceId === 'first'));
    assert.equal(await prisma.operationLog.count(), logsBefore);
    cases.push('50-device ceiling, no legacy trimming and atomic rejection on full transfer target');
    console.log(JSON.stringify({ ok: true, cases: cases.length, coverage: cases, database: path.join(scratch, 'synthetic.db'),
      productionTouched: false, pluginManualAcceptance: false }, null, 2));
  } finally { await prisma.$disconnect(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
