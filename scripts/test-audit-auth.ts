import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';

async function main() {
  const root = process.cwd();
  Object.assign(globalThis, { AsyncLocalStorage });
  Object.assign(process.env, { NODE_ENV: 'test', PRIVATE_PROMPTS_MIN_STATE: 'legacy-read' });
  delete process.env.PRIVATE_PROMPTS_POLICY_FILE;
  global.fetch = async () => { throw new Error('External requests prohibited in auth fixture'); };
  const database = (process.env.DATABASE_URL || '').replace(/^file:/, '');
  const fixtureDirectory = path.dirname(database);
  assert(process.env.DATABASE_URL === `file:${root}/.role-tests/audit-auth.db`
    || (process.env.DATABASE_URL?.startsWith('file:') && path.basename(database) === 'contract.db'
      && path.dirname(fixtureDirectory) === path.join(root, '.role-tests')
      && /^audit-auth-[A-Za-z0-9]+$/.test(path.basename(fixtureDirectory))),
  'Only the dedicated synthetic database is allowed');
  const req = createRequire(path.join(root, 'package.json'));
  const resolver = req('node:module');
  const originalResolve = resolver._resolveFilename;
  const marker = req.resolve('next/dist/compiled/server-only/empty.js');
  mock.method(resolver, '_resolveFilename', function (this: unknown, name: string, ...args: unknown[]) {
    return name === 'server-only' ? marker : Reflect.apply(originalResolve, this, [name, ...args]);
  });
  process.env.SESSION_SECRET = 'synthetic-auth-test-master-key-not-a-real-secret';
  process.env.FEISHU_ALLOWED_TENANT_KEY = 'synthetic-tenant';
  process.env.FEISHU_OPENAPI_BASE_URL = 'https://feishu.synthetic.invalid';
  process.env.FEISHU_AUTO_CREATE_USER = 'false';
  const { prisma } = await import('../src/lib/prisma');
  const db = prisma as any;
  const session = await import('../src/lib/auth/session');
  const passwords = await import('../src/lib/auth/password');
  const { NextRequest, NextResponse } = await import('next/server');
  const responseCookies = (response: Response) => new NextResponse(null, { headers: response.headers }).cookies;
  const { requestAsyncStorage } = await import('./fixtures/next-request-context');
  const cookie = (token: string) => `${session.SESSION_COOKIE}=${token}`;
  const context = <T>(token: string, run: () => T) => requestAsyncStorage.run({ headers: new Headers({ cookie: cookie(token) }) }, run);
  const results: { name: string; ok: boolean; error?: string; ms: number }[] = [];
  const metrics: Record<string, number> = {};
  async function test(name: string, run: () => Promise<void>) {
    const start = performance.now();
    try { await run(); results.push({ name, ok: true, ms: performance.now() - start }); }
    catch (error) { results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error), ms: performance.now() - start }); }
  }
  const passwordHash = await passwords.hashPassword('synthetic-correct-password');
  const user = await prisma.user.upsert({ where: { username: 'auth-fixture' }, update: { status: 'active', password_hash: passwordHash, feishu_user_id: null, feishu_open_id: null },
    create: { username: 'auth-fixture', name: 'Synthetic auth user', email: 'auth-fixture@example.invalid', password_hash: passwordHash, account_type: 'external' } });
  const admin = await prisma.user.upsert({ where: { username: 'auth-admin' }, update: { status: 'active' },
    create: { username: 'auth-admin', name: 'Synthetic admin', email: 'auth-admin@example.invalid', password_hash: passwordHash, role: 'admin' } });
  if (db.userSession) {
    await prisma.user.update({ where: { id: user.id }, data: { auth_origin: 'self_register' } });
    for (const row of [user, admin]) await prisma.creditAccount.upsert({ where: { user_id: row.id }, update: {}, create: { user_id: row.id } });
  }
  await test('wrong passwords have identical status and message for absent, active, disabled, pending, expired accounts', async () => {
    const missing = await session.login('absent@example.invalid', 'incorrect');
    assert.deepEqual(missing, { error: '账号或密码错误', status: 401 });
    for (const status of ['active', 'disabled', 'pending', 'expired']) {
      await prisma.user.update({ where: { id: user.id }, data: { status } });
      assert.deepEqual(await session.login(user.username, 'incorrect'), missing, status);
    }
  });
  await prisma.user.update({ where: { id: user.id }, data: { status: 'active' } });
  await test('logout route revokes the original server-side credential', async () => {
    const token = await session.createSession(user.id);
    assert.equal((await session.getSessionByToken(token))?.id, user.id);
    const route = await import('../src/app/api/auth/logout/route');
    assert.equal((await context(token, () => route.POST(new NextRequest('https://synthetic.invalid/api/auth/logout', { method: 'POST' })))).status, 200);
    assert.equal(await session.getSessionByToken(token), null);
  });
  await test('production cookie is host-only Secure HttpOnly Path=/ through the shared writer', async () => {
    const { setSessionCookie } = await import('../src/lib/auth/session-cookie');
    const previous = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: 'production' });
    try {
      const response = setSessionCookie(NextResponse.json({ ok: true }), 'a'.repeat(43));
      const written = response.cookies.get('__Host-sd2_session');
      assert(written, 'Missing __Host cookie');
      assert.equal(written.secure, true); assert.equal(written.httpOnly, true); assert.equal(written.path, '/'); assert.equal(written.domain, undefined);
    } finally { Object.assign(process.env, { NODE_ENV: previous }); }
  });
  await test('auth/me reports temporary database failure as 503, not signed out', async () => {
    const token = await session.createSession(user.id);
    const targets = [prisma.user, ...(db.userSession ? [db.userSession] : [])];
    const originals = targets.map((target) => target.findUnique);
    for (const target of targets) target.findUnique = async () => { throw Object.assign(new Error('Synthetic database busy'), { code: 'P1008' }); };
    try {
      const route = await import('../src/app/api/auth/me/route');
      const response = await context(token, () => route.GET(new NextRequest('https://synthetic.invalid/api/auth/me')));
      assert.equal(response.status, 503);
      assert.equal(Object.hasOwn(await response.json(), 'user'), false);
    } finally { targets.forEach((target, index) => { target.findUnique = originals[index]; }); }
  });
  await test('hashing returns a Promise and concurrent KDF work does not block the event loop', async () => {
    const pending = passwords.hashPassword('synthetic-event-loop-password');
    assert(pending instanceof Promise, 'Password hashing is synchronous');
    await pending;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try { await Promise.all(Array.from({ length: 50 }, () => passwords.verifyPassword('incorrect', passwordHash))); }
    finally { clearInterval(timer); }
    assert(ticks >= 2, 'KDF saturation blocked ordinary event-loop work');
    const loginRoute = await import('../src/app/api/auth/login/route');
    const meRoute = await import('../src/app/api/auth/me/route');
    const token = await session.createSession(user.id);
    const burst = Promise.all(Array.from({ length: 50 }, (_, index) => loginRoute.POST(new NextRequest('https://synthetic.invalid/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': `192.0.2.${index + 1}` },
      body: JSON.stringify({ identifier: `synthetic-burst-${index}`, password: 'incorrect' }),
    }))));
    const start = performance.now();
    const other = await context(token, () => meRoute.GET(new NextRequest('https://synthetic.invalid/api/auth/me')));
    metrics.authMeLatencyDuring50LoginRequestsMs = performance.now() - start;
    const responses = await burst;
    assert.equal(other.status, 200);
    assert(metrics.authMeLatencyDuring50LoginRequestsMs < 1500);
    assert(responses.every((response) => response.status === 401));
  });
  await test('production CLI endpoint is absent even when its old environment flag is enabled', async () => {
    const file = path.join(root, 'src/app/api/auth/feishu/cli-login/route.ts');
    if (!existsSync(file)) return;
    const previous = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: 'production', FEISHU_CLI_LOGIN_ENABLED: 'false' });
    try {
      const route = await import(path.join(root, 'src/app/api/auth/feishu/cli-login/route.ts'));
      const response = await route.POST(new NextRequest('https://synthetic.invalid/api/auth/feishu/cli-login', { method: 'POST' }));
      assert.equal(response.status, 404);
    } finally { Object.assign(process.env, { NODE_ENV: previous }); }
  });
  await test('unreferenced code exchange login route is removed', async () => {
    assert.equal(existsSync(path.join(root, 'src/app/api/auth/feishu/login-by-code/route.ts')), false);
  });
  await test('self-registration email collision cannot claim an existing account through Feishu', async () => {
    const feishu = await import('../src/lib/auth/feishu');
    const originalFetch = global.fetch;
    global.fetch = async (input) => {
      assert(String(input).startsWith('https://feishu.synthetic.invalid/'), 'Unexpected external request');
      return Response.json(String(input).includes('/auth/v3/') ? { code: 0, tenant_access_token: 'synthetic-token', expire: 3600 } : { code: 0, data: {} });
    };
    try {
      await assert.rejects(() => feishu.loginWithFeishuProfile({ openId: 'synthetic-open-id', userId: 'synthetic-user-id', unionId: null,
        tenantKey: 'synthetic-tenant', employeeNo: null, name: 'Synthetic SSO', enName: null, avatarUrl: null, mobile: null,
        email: user.email, departmentIds: [], raw: { email: user.email } }), /绑定|binding|原账号/);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).feishu_open_id, null);
    } finally { global.fetch = originalFetch; }
  });
  // These cases use the real newly-created tables after the initial counterexamples above.
  if (db.userSession) {
    const store = await import('../src/lib/auth/session-store');
    await test('server idle seven-day and absolute thirty-day expiry are enforced', async () => {
      for (const data of [{ last_activity_at: new Date(Date.now() - 7 * 86400000 - 1000) }, { expires_at: new Date(Date.now() - 1) }, { created_at: new Date(Date.now() - 30 * 86400000 - 1000) }]) {
        const token = await session.createSession(user.id);
        await db.userSession.updateMany({ where: { user_id: user.id, revoked_at: null }, data });
        assert.equal(await session.getSessionByToken(token), null);
      }
    });
    await test('only opaque random tokens are issued and only digests persist', async () => {
      const a = await session.createSession(user.id), b = await session.createSession(user.id);
      assert.match(a, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a, b);
      const rows = await db.userSession.findMany({ where: { user_id: user.id } });
      assert(rows.every((row: any) => !JSON.stringify(row).includes(a) && !JSON.stringify(row).includes(b)));
      assert.equal(await session.getSessionByToken('bGVnYWN5.signature'), null);
    });
    await test('password reset route transaction revokes all existing sessions', async () => {
      const token = await session.createSession(user.id);
      const adminToken = await session.createSession(admin.id);
      const route = await import('../src/app/api/admin/users/[id]/route');
      const request = new NextRequest('https://synthetic.invalid/api/admin/users/fixture', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-changed-password', reason: 'synthetic reset' }) });
      const response = await context(adminToken, () => route.PATCH(request, { params: Promise.resolve({ id: user.id }) }));
      assert.equal(response.status, 200);
      assert.equal(await session.getSessionByToken(token), null);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password_hash.split(':').length, 3);
    });
    await test('revoke-all does not revoke another account', async () => {
      const mine = await session.createSession(user.id), theirs = await session.createSession(admin.id);
      await store.revokeAllSessions(user.id, 'synthetic-test');
      assert.equal(await session.getSessionByToken(mine), null);
      assert.equal((await session.getSessionByToken(theirs))?.id, admin.id);
    });
    await test('disable then enable never resurrects any old session', async () => {
      const token = await session.createSession(user.id), adminToken = await session.createSession(admin.id);
      const disable = await import('../src/app/api/admin/users/[id]/disable/route');
      const enable = await import('../src/app/api/admin/users/[id]/enable/route');
      const request = new NextRequest('https://synthetic.invalid/fixture', { method: 'POST' });
      assert.equal((await context(adminToken, () => disable.POST(request, { params: Promise.resolve({ id: user.id }) }))).status, 200);
      assert.equal(await session.getSessionByToken(token), null);
      assert.equal((await context(adminToken, () => enable.POST(request, { params: Promise.resolve({ id: user.id }) }))).status, 200);
      assert.equal(await session.getSessionByToken(token), null);
    });
    await test('logout-all route revokes every device only for the authenticated user', async () => {
      const a = await session.createSession(user.id), b = await session.createSession(user.id), other = await session.createSession(admin.id);
      const route = await import('../src/app/api/auth/logout-all/route');
      assert.equal((await context(a, () => route.POST(new NextRequest('https://synthetic.invalid/api/auth/logout-all', { method: 'POST' })))).status, 200);
      assert.equal(await session.getSessionByToken(a), null); assert.equal(await session.getSessionByToken(b), null);
      assert.equal((await session.getSessionByToken(other))?.id, admin.id);
      assert.equal((await context(a, () => route.POST(new NextRequest('https://synthetic.invalid/api/auth/logout-all', { method: 'POST' })))).status, 401);
    });
    await test('admin force-logout route enforces admin permission and revokes the selected user', async () => {
      const mine = await session.createSession(user.id), adminToken = await session.createSession(admin.id);
      const route = await import('../src/app/api/admin/users/[id]/revoke-sessions/route');
      const request = new NextRequest('https://synthetic.invalid/fixture', { method: 'POST' });
      assert.equal((await context(mine, () => route.POST(request, { params: Promise.resolve({ id: admin.id }) }))).status, 403);
      assert.equal((await context(adminToken, () => route.POST(request, { params: Promise.resolve({ id: user.id }) }))).status, 200);
      assert.equal(await session.getSessionByToken(mine), null);
      assert.equal((await session.getSessionByToken(adminToken))?.id, admin.id);
    });
    await test('account role and type changes revoke earlier sessions atomically', async () => {
      const token = await session.createSession(user.id), adminToken = await session.createSession(admin.id);
      const route = await import('../src/app/api/admin/users/[id]/route');
      const request = new NextRequest('https://synthetic.invalid/fixture', { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_type: 'internal', role: 'admin', reason: 'synthetic role change' }) });
      assert.equal((await context(adminToken, () => route.PATCH(request, { params: Promise.resolve({ id: user.id }) }))).status, 200);
      assert.equal(await session.getSessionByToken(token), null);
      await prisma.user.update({ where: { id: user.id }, data: { role: 'user', account_type: 'external' } });
    });
    await test('registration challenge attempt limit survives repeated requests and rejects a correct sixth code', async () => {
      const challenge = await import('../src/lib/auth/registration/challenge');
      const email = `challenge-${Date.now()}@example.invalid`, nonce = challenge.createRegisterNonce();
      const code = '123456';
      const token = await challenge.createRegisterChallengeToken({ email, name: 'Synthetic challenge', passwordHash,
        codeHash: challenge.hashRegisterCode(email, nonce, code), nonce, expiresAt: Date.now() + 600000 });
      const route = await import('../src/app/api/auth/register/verify/route');
      const run = (value: string) => requestAsyncStorage.run({ headers: new Headers({ cookie: `register_challenge=${token}` }) }, () => route.POST(new NextRequest('https://synthetic.invalid/api/auth/register/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: value }) })));
      for (let i = 0; i < 5; i++) assert.equal((await run('000000')).status, 400);
      assert.equal((await run(code)).status, 400);
      assert.equal(await prisma.user.findUnique({ where: { email } }), null);
    });
    await test('successful registration consumes its challenge once and stores verified self-registration provenance', async () => {
      const challenge = await import('../src/lib/auth/registration/challenge');
      const email = `verified-${Date.now()}@example.invalid`, nonce = challenge.createRegisterNonce(), code = '654321';
      const token = await challenge.createRegisterChallengeToken({ email, name: 'Synthetic registration', passwordHash,
        codeHash: challenge.hashRegisterCode(email, nonce, code), nonce, expiresAt: Date.now() + 600000 });
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      const route = await import('../src/app/api/auth/register/verify/route');
      const verify = () => requestAsyncStorage.run({ headers: new Headers({ cookie: `register_challenge=${token}` }) }, () => route.POST(new NextRequest('https://synthetic.invalid/fixture', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) })));
      const response = await verify();
      assert.equal(response.status, 201);
      const registered = await prisma.user.findUniqueOrThrow({ where: { email } });
      assert.equal(registered.auth_origin, 'self_register'); assert(registered.email_verified_at);
      assert((await session.getSessionByToken(responseCookies(response).get(session.SESSION_COOKIE)!.value))?.id === registered.id);
      assert.equal((await verify()).status, 400);
    });
    await test('closed registration rejects both request and verify endpoints before any provider call', async () => {
      const old = process.env.SELF_REGISTRATION_ENABLED;
      process.env.SELF_REGISTRATION_ENABLED = 'false';
      try {
        const request = new NextRequest('https://synthetic.invalid/fixture', { method: 'POST' });
        const requestCode = await import('../src/app/api/auth/register/request-code/route');
        const verify = await import('../src/app/api/auth/register/verify/route');
        assert.equal((await requestCode.POST(request)).status, 404);
        assert.equal((await verify.POST(request)).status, 404);
      } finally { if (old === undefined) delete process.env.SELF_REGISTRATION_ENABLED; else process.env.SELF_REGISTRATION_ENABLED = old; }
    });
    await test('Feishu auto-claim requires admin-created origin and an explicit verified-email signal; phone and wrong tenants never claim', async () => {
      const feishu = await import('../src/lib/auth/feishu');
      const originalFetch = global.fetch;
      const row = await prisma.user.create({ data: { name: 'Synthetic provisioned', username: `auth-provisioned-${Date.now()}`,
        email: `provisioned-${Date.now()}@example.invalid`, password_hash: passwordHash, auth_origin: 'admin', mobile: '18800000000' } });
      const profile = { openId: `synthetic-provisioned-${Date.now()}`, userId: null, unionId: null, tenantKey: 'synthetic-tenant',
        employeeNo: null, name: row.name, enName: null, avatarUrl: null, mobile: null, email: row.email, emailVerified: false, departmentIds: [], raw: {} };
      global.fetch = async (input) => {
        assert(String(input).startsWith('https://feishu.synthetic.invalid/'));
        return Response.json(String(input).includes('/auth/v3/') ? { code: 0, tenant_access_token: 'synthetic-token' } : { code: 0, data: {} });
      };
      try {
        await assert.rejects(() => feishu.loginWithFeishuProfile(profile), /绑定/);
        await assert.rejects(() => feishu.loginWithFeishuProfile({ ...profile, email: null, mobile: row.mobile }), /未开通/);
        await assert.rejects(() => feishu.loginWithFeishuProfile({ ...profile, emailVerified: true, tenantKey: 'other-tenant' }), /企业/);
        assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: row.id } })).feishu_open_id, null);
        const accepted = await feishu.loginWithFeishuProfile({ ...profile, emailVerified: true });
        assert.equal(accepted.user.id, row.id);
        assert.equal((await session.getSessionByToken(accepted.token))?.id, row.id);
      } finally { global.fetch = originalFetch; }
    });
    await test('production startup requires tenant plus verified email delivery or explicitly closed registration', async () => {
      const req = createRequire(path.join(root, 'package.json'));
      const { assertStartupAuthPolicy } = req('./src/lib/auth/login-policy.cjs');
      const keys = ['NODE_ENV', 'FEISHU_ALLOWED_TENANT_KEY', 'SELF_REGISTRATION_ENABLED', 'REGISTER_EMAIL_VERIFICATION', 'RESEND_API_KEY', 'AUTH_EMAIL_FROM', 'EMAIL_FROM'];
      const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      try {
        Object.assign(process.env, { NODE_ENV: 'production', FEISHU_ALLOWED_TENANT_KEY: '', SELF_REGISTRATION_ENABLED: 'false' });
        assert.throws(assertStartupAuthPolicy, /allowed-tenant/);
        Object.assign(process.env, { FEISHU_ALLOWED_TENANT_KEY: 'synthetic-tenant' });
        assert.doesNotThrow(assertStartupAuthPolicy);
        Object.assign(process.env, { SELF_REGISTRATION_ENABLED: 'true', REGISTER_EMAIL_VERIFICATION: 'false' });
        assert.throws(assertStartupAuthPolicy, /verified-registration-or-closed/);
        Object.assign(process.env, { REGISTER_EMAIL_VERIFICATION: 'true', RESEND_API_KEY: '', AUTH_EMAIL_FROM: '', EMAIL_FROM: '' });
        assert.throws(assertStartupAuthPolicy, /verified-registration-or-closed/);
        Object.assign(process.env, { RESEND_API_KEY: 'synthetic-email-provider-key', AUTH_EMAIL_FROM: 'synthetic@example.invalid' });
        assert.doesNotThrow(assertStartupAuthPolicy);
      } finally { for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    });
    await test('unconfirmed auth payloads preserve the real upload owner; only explicit user:null clears identity', async () => {
      const { confirmedSessionUser } = await import('../src/lib/auth/session-response');
      const { setUploadSessionOwner, uploadSession } = await import('../src/lib/http/upload-session');
      setUploadSessionOwner(user.id);
      for (const payload of [{ error: 'unavailable' }, {}, { user: undefined }, { user: {} }]) {
        assert.throws(() => confirmedSessionUser(payload));
        assert.equal(uploadSession().ownerId, user.id);
      }
      assert.equal(confirmedSessionUser({ user: null }), null);
      assert.deepEqual(confirmedSessionUser({ user: { id: user.id } }), { id: user.id });
    });
    await test('explicit authenticated Feishu binding survives only its initiating session and preserves OAuth-only proof issuance', async () => {
      const originalFetch = global.fetch;
      const before = { enabled: process.env.FEISHU_LOGIN_ENABLED, app: process.env.FEISHU_APP_ID, secret: process.env.FEISHU_APP_SECRET, uri: process.env.FEISHU_REDIRECT_URI };
      Object.assign(process.env, { FEISHU_LOGIN_ENABLED: 'true', FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-app-secret', FEISHU_REDIRECT_URI: 'https://synthetic.invalid/api/auth/feishu/callback' });
      const token = await session.createSession(user.id);
      const openId = `synthetic-binding-${Date.now()}`;
      global.fetch = async (input) => {
        const url = String(input); assert(url.startsWith('https://feishu.synthetic.invalid/'));
        return Response.json(url.includes('/authen/v2/oauth/token') ? { code: 0, data: { access_token: 'synthetic-user-token' } }
          : url.includes('/authen/v1/user_info') ? { code: 0, data: { open_id: openId, user_id: openId, tenant_key: 'synthetic-tenant', email: user.email, name: 'Synthetic bound user' } }
            : url.includes('/auth/v3/') ? { code: 0, tenant_access_token: 'synthetic-tenant-token' } : { code: 0, data: {} });
      };
      try {
        const bind = await import('../src/app/api/auth/feishu/bind/route');
        const request = new NextRequest('https://synthetic.invalid/api/auth/feishu/bind', { method: 'POST', headers: { cookie: cookie(token), origin: 'https://synthetic.invalid' } });
        const start = await context(token, () => bind.POST(request));
        assert.equal(start.status, 200);
        const feishu = await import('../src/lib/auth/feishu');
        const stateCookie = responseCookies(start).get(feishu.FEISHU_STATE_COOKIE)!.value;
        const url = new URL((await start.json()).authorize_url);
        const state = feishu.verifyFeishuOAuthState(stateCookie, url.searchParams.get('state'))!;
        assert.equal(state.binding?.userId, user.id);
        const otherToken = await session.createSession(user.id);
        const callback = await import('../src/app/api/auth/feishu/callback/route');
        const make = (value: string) => new NextRequest(`https://synthetic.invalid/api/auth/feishu/callback?code=synthetic-code&state=${url.searchParams.get('state')}`, {
          headers: { cookie: `${cookie(value)}; ${feishu.FEISHU_STATE_COOKIE}=${stateCookie}` } });
        const rejected = await context(otherToken, () => callback.GET(make(otherToken)));
        assert.match(rejected.headers.get('location') || '', /binding_session_expired/);
        assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).feishu_open_id, null);
        const fixture = path.join(root, '.role-tests/identity');
        mkdirSync(path.join(fixture, 'runtime'), { recursive: true, mode: 0o700 });
        const policyFile = path.join(fixture, 'policy.json');
        writeFileSync(policyFile, JSON.stringify({ schema: 'private-prompt-policy.v1', revision: 'auth-fixture', state: 'legacy-read', minimumReader: 1,
          identities: [{ userId: user.id, tenant: 'synthetic-tenant', subject: openId }], origins: [], authorKinds: [], destinations: [], consumers: ['web'],
          keys: Object.fromEntries(['body', 'index', 'backup'].map((key) => [key, { active: 'synthetic', files: { synthetic: path.join(fixture, `${key}.not-needed-by-identity-proof`) } }])) }), { mode: 0o600 });
        const previousPolicy = process.env.PRIVATE_PROMPTS_POLICY_FILE, previousRoot = process.env.PRIVATE_PROMPTS_FIXTURE_ROOT;
        process.env.PRIVATE_PROMPTS_POLICY_FILE = policyFile;
        process.env.PRIVATE_PROMPTS_FIXTURE_ROOT = fixture;
        process.chdir(path.join(fixture, 'runtime'));
        try {
          const accepted = await context(token, () => callback.GET(make(token)));
          assert.match(accepted.headers.get('location') || '', /status=success/);
          assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).feishu_open_id, openId);
          const newToken = responseCookies(accepted).get(session.SESSION_COOKIE)!.value;
          const identity = await import('../src/lib/security/private-prompt-identity.server');
          const proof = responseCookies(accepted).get(identity.PRIVATE_IDENTITY_COOKIE)?.value;
          assert(proof, 'Genuine OAuth must preserve the allowlisted identity proof');
          const principal = await session.getSessionByToken(newToken);
          assert(principal);
          assert.equal(identity.authenticatePrivateIdentity(principal, proof, newToken), true);
          assert.equal(identity.authenticatePrivateIdentity(principal, proof, otherToken), false);
          const passwordPrincipal = await session.getSessionByToken(otherToken);
          assert(passwordPrincipal);
          assert.equal(identity.privatePromptCapabilities(passwordPrincipal, []).canReadPrivatePrompt, false);
        } finally {
          process.chdir(root);
          if (previousPolicy === undefined) delete process.env.PRIVATE_PROMPTS_POLICY_FILE; else process.env.PRIVATE_PROMPTS_POLICY_FILE = previousPolicy;
          if (previousRoot === undefined) delete process.env.PRIVATE_PROMPTS_FIXTURE_ROOT; else process.env.PRIVATE_PROMPTS_FIXTURE_ROOT = previousRoot;
        }
      } finally {
        global.fetch = originalFetch;
        for (const [key, value] of Object.entries({ FEISHU_LOGIN_ENABLED: before.enabled, FEISHU_APP_ID: before.app, FEISHU_APP_SECRET: before.secret, FEISHU_REDIRECT_URI: before.uri })) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    });
  }
  await test('real login route applies the shared IP limiter before password verification', async () => {
    const loginRoute = await import('../src/app/api/auth/login/route');
    const responses = [];
    for (let index = 0; index < 21; index++) {
      responses.push(await loginRoute.POST(new NextRequest('https://synthetic.invalid/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '192.0.2.200' },
        body: JSON.stringify({ identifier: `synthetic-limit-${index}`, password: 'incorrect' }),
      })));
    }
    assert.equal(responses[0].status, 401);
    assert.equal(responses[20].status, 429);
    assert(Number(responses[20].headers.get('retry-after')) > 0);
  });
  await prisma.$disconnect();
  mkdirSync(path.join(root, '.role-tests'), { recursive: true });
  const artifact = { base: '208c71859ec56c14b3d8be823bd092f5f4e220df', phase: process.env.AUTH_TEST_PHASE || 'green', database: 'isolated synthetic SQLite only', results, metrics, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  writeFileSync(path.join(root, `.role-tests/audit-auth-${artifact.phase}.json`), JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
  if (artifact.failed) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
