'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function main() {
  const fixturePath = fs.realpathSync(process.argv[2] || '');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const scratch = path.resolve('.role-tests') + path.sep;
  if (fixture.schema !== 'role-ui-fixture.v1' || fixture.synthetic !== true || fixture.root !== process.cwd()
    || !fixturePath.startsWith(scratch) || fixture.databaseUrl !== `file:${path.join(path.dirname(fixturePath), 'synthetic.db')}`
    || !fixture.sessionSecret || !fixture.sessionToken) throw new Error('Invalid isolated synthetic fixture');
  const port = Number(process.argv[3] || 3327);
  const mode = process.argv[4] || 'production';
  if (!['production', 'development'].includes(mode)) throw new Error('Invalid candidate runtime mode');
  const distDirectory = mode === 'production' ? '.next-prod-candidate' : path.relative(process.cwd(), path.join(fixture.directory, 'next-build'));
  if (mode === 'production' && !fs.existsSync(path.resolve(distDirectory, 'BUILD_ID'))) throw new Error('Unified candidate build is not available yet');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
  // Only an allowlist of host environment is inherited. No caller's keys or DB URL.
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { DATABASE_URL: fixture.databaseUrl, SESSION_SECRET: fixture.sessionSecret,
    NEXT_DIST_DIR: distDirectory, NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `--require=${path.resolve('scripts/role-c1-ui-network-block.cjs')}`, NODE_ENV: mode });
  // Next loads .env itself: forbid inherited project environment rather than trusting it.
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    if (fs.existsSync(path.resolve(name))) throw new Error(`Remove private environment from isolated workspace before candidate serve: ${name}`);
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const loginFixture = path.join(fixture.directory, 'playwright-auth.json');
  fs.writeFileSync(loginFixture, JSON.stringify({ cookies: [{ name: 'session', value: fixture.sessionToken,
    domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax', expires: -1 }], origins: [] }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(fixture.directory, 'ui-runtime.json'), JSON.stringify({ synthetic: true, baseUrl,
    pageUrl: baseUrl + fixture.pagePath, authFixture: loginFixture, mode, distDirectory,
    buildId: mode === 'production' ? fs.readFileSync(path.resolve(distDirectory, 'BUILD_ID'), 'utf8').trim() : null,
    externalNetworkBlocked: true }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ baseUrl, pageUrl: baseUrl + fixture.pagePath, authFixture: loginFixture, synthetic: true }));
  const child = spawn(process.execPath, [path.resolve('node_modules/next/dist/bin/next'), mode === 'production' ? 'start' : 'dev', '-H', '127.0.0.1', '-p', String(port)],
    { env, cwd: process.cwd(), stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code === null ? 0 : code; });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
