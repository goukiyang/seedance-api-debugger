import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';

export const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

/** A fresh private SQLite and storage root, established before application imports. */
export async function traceFixture(input: { file: string; schema: string; marker: string; sources: string[]; checks: readonly string[] }) {
  process.exitCode = 1;
  const wallNow = Date.now.bind(Date);
  const deadline = setTimeout(() => { console.error('TRACE03 isolated fixture exceeded its deadline'); process.exit(1); }, 175000);
  deadline.ref();
  const root = realpathSync(process.cwd()), startedAt = Date.now();
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.match(runId || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  const sourceSha256 = Object.fromEntries(input.sources.map(file => [file, sha256(readFileSync(path.join(root, file)))]));
  const fixtureSha256 = sha256(readFileSync(path.join(root, input.file)));
  const previousUmask = process.umask(0o077), scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  assert.ok(lstatSync(scratch).isDirectory() && !lstatSync(scratch).isSymbolicLink());
  const directory = mkdtempSync(path.join(scratch, 'image-trace-')), databasePath = path.join(directory, 'synthetic.db');
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined);
  process.env.DATABASE_URL = `file:${databasePath}`;
  Object.assign(process.env, { NODE_ENV: 'test' });
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const require = createRequire(import.meta.url), prismaPackage = require.resolve('prisma/package.json');
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) env[name] = process.env[name];
  const schemaLog = execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push',
    '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  writeFileSync(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  Reflect.set(globalThis, 'prisma', db);
  // Runtime readiness hashes code beneath cwd; expose only immutable candidate sources.
  symlinkSync(path.join(root, 'src'), path.join(directory, 'src'), 'dir');
  process.chdir(directory);
  let forbiddenCalls = 0;
  const blocked = () => { forbiddenCalls++; throw new Error('External provider/network forbidden in TRACE03 fixture'); };
  mock.method(globalThis, 'fetch', blocked);
  mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked);
  mock.method(dns, 'lookup', blocked);
  const checks: string[] = [];
  return { root, directory, db, blocked,
    check(name: string) {
      assert.equal(name, input.checks[checks.length], 'All engineering assertions must complete in the declared order');
      checks.push(name);
      console.error('[image-trace-fixture-check]', name);
    },
    async finish(evidence: Record<string, unknown> = {}) {
      assert.deepEqual(checks, input.checks);
      assert.equal(forbiddenCalls, 0);
      await db.$disconnect();
      const receipt = path.join(directory, 'receipt.json');
      writeFileSync(receipt, JSON.stringify({ ...evidence, schema: input.schema, synthetic: true, runId, completed: true,
        startedAt, finishedAt: wallNow(), fixtureSha256, sourceSha256, checks, forbiddenCalls,
        ...(Reflect.get(globalThis, Symbol.for('image-engineering-package-view'))
          ? { engineeringPackageView: Reflect.get(globalThis, Symbol.for('image-engineering-package-view')) } : {}),
        productionWrites: 0, paidRequests: 0, browserRuns: 0 }, null, 2), { mode: 0o600, flag: 'wx' });
      mock.restoreAll(); process.chdir(root); process.umask(previousUmask); clearTimeout(deadline);
      process.exitCode = 0;
      console.log(input.marker + receipt);
    },
  };
}
