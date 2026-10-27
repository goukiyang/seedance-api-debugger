'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const root = fs.realpathSync(process.cwd());
  assert.match(root, /^\/data\/video-api-debugger\/managed-releases\/[a-f0-9]{40}$/);
  for (const name of ['.env', '.env.local', '.env.production', 'storage', 'public/uploads', 'public/videos']) {
    assert.equal(fs.existsSync(path.join(root, name)), false, `Candidate already contains data/config: ${name}`);
    assert.throws(() => fs.lstatSync(path.join(root, name)), { code: 'ENOENT' });
  }
  assert.equal(fs.realpathSync(path.join(root, '.role-tests')), path.join(root, '.role-tests'));
  assert.equal(process.getuid() === 0, false, 'Run as the ordinary service account');
  assert.ok(fs.existsSync(path.join(root, '.next-prod-candidate', 'BUILD_ID')));
  const fixture = fs.mkdtempSync(path.join(root, '.role-tests', 'image-isolation-'));
  const database = path.join(fixture, 'synthetic.sqlite');
  const secret = crypto.randomBytes(48).toString('base64url');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
    DATABASE_URL: `file:${database}`, SESSION_SECRET: secret, NODE_ENV: 'production',
    NEXT_DIST_DIR: '.next-prod-candidate', NEXT_TELEMETRY_DISABLED: '1',
    FEISHU_ALLOWED_TENANT_KEY: 'audit-fixture-tenant',
  };
  const setup = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'],
    { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(setup.status, 0, setup.stderr);
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const sharp = require('../src/lib/media/image-decoder-policy.cjs');
  const suffix = path.basename(fixture);
  const uploadPath = `/uploads/assets/${suffix}.png`;
  const imageFile = path.join(root, 'public', uploadPath);
  let server;
  const log = fs.openSync(path.join(fixture, 'server.log'), 'wx');
  try {
    const users = [];
    for (const label of ['a', 'b']) {
      users.push(await db.user.create({ data: {
        id: `${suffix}-${label}`, name: `Synthetic ${label}`, username: `${suffix}-${label}`,
        email: `${suffix}-${label}@example.invalid`, password_hash: 'synthetic-not-a-login-password',
        role: 'user', account_type: 'internal', status: 'active',
        feishu_user_id: `${suffix}-${label}`, feishu_tenant_key: env.FEISHU_ALLOWED_TENANT_KEY,
      } }));
    }
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#30a060' } }).png().toBuffer();
    fs.mkdirSync(path.dirname(imageFile), { recursive: true });
    fs.writeFileSync(imageFile, bytes, { flag: 'wx' });
    await db.asset.create({ data: { owner_id: users[0].id, type: 'image', original_url: uploadPath,
      file_name: path.basename(imageFile), mime_type: 'image/png', file_size: bytes.length, width: 32, height: 32 } });
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    server = spawn(process.execPath, ['--require', './scripts/server-runtime.cjs', 'node_modules/next/dist/bin/next',
      'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', log, log] });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (server.exitCode !== null) throw new Error('Synthetic candidate server exited before readiness');
      try {
        const result = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
        await result.arrayBuffer();
        ready = true;
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Synthetic candidate server did not become ready');
    const cookies = users.map(user => {
      const payload = Buffer.from(user.id).toString('base64');
      return `session=${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64')}`;
    });
    const optimizer = `/_next/image?url=${encodeURIComponent(uploadPath)}&w=64&q=75`;
    const observations = [];
    async function check(route, expected, cookie, bypass = false) {
      const headers = { ...(cookie ? { cookie } : {}), ...(bypass ? { 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware' } : {}) };
      const response = await fetch(base + route, { headers, signal: AbortSignal.timeout(15000) });
      const body = Buffer.from(await response.arrayBuffer());
      observations.push({ route: route === optimizer ? 'optimizer' : 'original', authenticated: Boolean(cookie), bypass, status: response.status });
      assert.equal(response.status, expected, JSON.stringify(observations.at(-1)));
      if (expected === 200) assert.equal((await sharp(body).metadata()).format !== undefined, true);
    }
    await check(uploadPath, 404, null, true);
    await check(optimizer, 404, null, true);
    await check(uploadPath, 200, cookies[0]);
    await check(optimizer, 200, cookies[0]);
    await check(optimizer, 404, cookies[1]);
    await check(optimizer, 404, null);
    await check(optimizer, 404, cookies[1], true);
    await check(uploadPath, 404, cookies[1], true);
    await check(optimizer, 200, cookies[0]);
    const result = { schema: 'next-image-isolation.v1', passed: true, syntheticOnly: true, node: process.version, observations };
    fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    if (server && server.exitCode === null) {
      const closed = once(server, 'exit');
      server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
      await closed;
      clearTimeout(timer);
    }
    fs.closeSync(log);
    await db.$disconnect();
    if (fs.existsSync(imageFile)) fs.unlinkSync(imageFile);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
