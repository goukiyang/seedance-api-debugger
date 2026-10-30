import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { mock } from 'node:test';
import { ARCH03_SOURCES } from './arch03-fixture-inputs.mjs';

async function main() {
  const root = process.cwd(), source = path.resolve(process.argv[2] || '');
  assert.ok(source.startsWith(path.join(root, '.role-tests') + path.sep));
  const previous = JSON.parse(await readFile(path.join(source, 'receipt.json'), 'utf8'));
  assert.equal(previous.synthetic, true); assert.equal(previous.completed, true); assert.equal(previous.productionWrites, 0);
  const directory = await mkdtemp(path.join(root, '.role-tests/arch03-capacity-'));
  await copyFile(path.join(source, 'synthetic.db'), path.join(directory, 'synthetic.db'));
  for (const key of Object.keys(process.env)) if (!['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'].includes(key)) delete process.env[key];
  Object.assign(process.env, { DATABASE_URL: `file:${path.join(directory, 'synthetic.db')}`, NODE_ENV: 'test' });
  const require = createRequire(import.meta.url), resolver = require('node:module'), originalResolve = resolver._resolveFilename;
  const marker = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js');
  mock.method(resolver, '_resolveFilename', (...args: unknown[]) => args[0] === 'server-only' ? marker : originalResolve.apply(resolver, args));
  let forbiddenCalls = 0, measuring = false, rows = 0, largestRead = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('ARCH03 capacity cannot access network or business services'); };
  mock.method(globalThis, 'fetch', forbidden); mock.method(http, 'request', forbidden); mock.method(http, 'get', forbidden);
  mock.method(https, 'request', forbidden); mock.method(https, 'get', forbidden); mock.method(dns, 'lookup', forbidden);
  const { PrismaClient } = await import('@prisma/client');
  const { catalogDirectoryWrites } = await import('../src/lib/catalog-directory-writes');
  const base = new PrismaClient();
  const observed = catalogDirectoryWrites(base).$extends({ query: { async $allOperations({ args, query }) {
    const result = await query(args);
    if (measuring && Array.isArray(result)) { rows += result.length; largestRead = Math.max(largestRead, result.length); }
    return result;
  } } });
  Reflect.set(globalThis, 'prisma', observed); Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  const startedAt = new Date().toISOString(); let completed = false, metrics: unknown, measurements: Array<Record<string, unknown>> = [];
  process.chdir(directory);
  try {
    assert.equal(await base.imageStudioTask.count({ where: { id: { startsWith: 'scale-' } } }), 0);
    const { runArch03Capacity } = await import('./arch03-capacity');
    metrics = await runArch03Capacity(observed as unknown as typeof base,
      () => { measuring = true; rows = 0; largestRead = 0; }, () => { measuring = false; return { rows, largestRead }; },
      value => { measurements = [...value]; });
    assert.equal(forbiddenCalls, 0); completed = true;
  } finally {
    process.chdir(root); await base.$disconnect(); mock.restoreAll();
    const files = [...ARCH03_SOURCES, 'scripts/arch03-capacity-run.ts', 'src/lib/assets/catalog-batches.ts'];
    const sourceSha256 = Object.fromEntries(await Promise.all(files.map(async (file: string) => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
    const receipt = path.join(directory, 'receipt.json');
    await writeFile(receipt, JSON.stringify({ schema: 'arch03-capacity.v1', startedAt, finishedAt: new Date().toISOString(), source: path.basename(source),
      metrics, measurements, sourceSha256, completed, synthetic: true, productionWrites: 0, forbiddenCalls, paidRequests: 0, browserRuns: 0 }, null, 2), { mode: 0o600 });
    console.log(`ARCH03 capacity receipt: ${receipt}`);
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
