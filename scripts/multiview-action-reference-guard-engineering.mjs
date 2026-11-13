import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json')), ts = require('typescript'), { PrismaClient } = require('@prisma/client');
const oldFile = process.argv[2]; assert.ok(oldFile && path.isAbsolute(oldFile), 'Exact original guard worker source is required');
const oldSource = await fs.readFile(oldFile, 'utf8');
const currentSource = await fs.readFile(process.argv[3] || 'src/lib/template-studio/worker.ts', 'utf8');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sd2-mv-reference-guard-'));
const url = 'file:' + path.join(temporary, 'isolated.sqlite');
let prisma;
try {
  const setup = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'], {
    env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(setup.status, 0, setup.stderr);
  prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.user.create({ data: { id: 'owner', name: 'Fixture', username: 'fixture', email: 'fixture@example.invalid', password_hash: 'fixture-only' } });
  await prisma.videoStudioDraft.create({ data: { id: 'draft', owner_user_id: 'owner', purpose: 'multiview-action', name: 'Fixture' } });
  const imagePurpose = 'multiview-action-reference';
  const queued = id => ({ id, owner_user_id: 'owner', purpose: imagePurpose, draft_id: 'draft', draft_revision: 1,
    request_id: id + '-original', request_fingerprint: 'fixture', source: 'blank', mode: 'llm', status: 'queued', delivery_state: 'not_sent', snapshot_json: '{}' });
  await prisma.videoStudioRun.create({ data: { ...queued('image'), created_at: new Date(1) } });
  await prisma.videoStudioRun.create({ data: { ...queued('legacy'), purpose: 'studio', created_at: new Date(2) } });
  function load(source) {
    const ast = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true);
    const parts = ast.statements.filter(node =>
      ts.isFunctionDeclaration(node) && ['claimStudioRun', 'recoverExpiredStudioRuns'].includes(node.name?.text)
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === 'LEASE_MS'));
    const code = ts.transpileModule(parts.map(node => node.getText(ast)).join('\n') + '\nglobalThis.worker={claimStudioRun,recoverExpiredStudioRuns};', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const env = { exports: {}, prisma, randomUUID, Date, MULTIVIEW_ACTION_REFERENCE_PURPOSE: imagePurpose };
    vm.runInNewContext(code, env); return env.worker;
  }
  const old = load(oldSource), current = load(currentSource);
  assert.equal((await old.claimStudioRun()).run.id, 'legacy', 'old worker must keep processing ordinary work');
  assert.equal(await old.claimStudioRun(), null, 'old worker must never claim image-only work');
  let row = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: 'image' } });
  assert.equal(row.status, 'queued'); assert.equal(row.attempt, 0);
  assert.equal((await current.claimStudioRun()).run.id, 'image', 'new worker must accept the image-only purpose');
  await prisma.videoStudioRun.update({ where: { id: 'image' }, data: { delivery_state: 'sending', lease_expires_at: new Date(1) } });
  await old.recoverExpiredStudioRuns();
  row = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: 'image' } });
  assert.equal(row.status, 'uncertain'); assert.equal(row.delivery_state, 'unknown');
  assert.equal(row.request_id, 'image-original'); assert.equal(row.attempt, 1); assert.equal(row.prompt, null);
  await prisma.videoStudioRun.create({ data: { ...queued('not-sent'), status: 'running', lease_token: 'fixture', lease_expires_at: new Date(1) } });
  await old.recoverExpiredStudioRuns();
  row = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: 'not-sent' } });
  assert.equal(row.status, 'queued'); assert.equal(row.delivery_state, 'not_sent');
  assert.equal(await old.claimStudioRun(), null);
  console.log(JSON.stringify({ passed: true, checks: ['old guard continues ordinary text work', 'old guard leaves queued image intent untouched',
    'current worker claims the image-only purpose', 'old recovery preserves sent image request as unknown without replay',
    'old recovery safely requeues proven not-sent image work', 'old worker still cannot consume that requeued image'],
    oldWorkerSha256: createHash('sha256').update(oldSource).digest('hex'), currentWorkerSha256: createHash('sha256').update(currentSource).digest('hex'),
    isolation: { database: 'temporary-isolated-sqlite', productionDatabaseOpened: false, realFetches: 0, generationCalls: 0 } }));
} finally {
  if (prisma) await prisma.$disconnect();
  await fs.rm(temporary, { recursive: true, force: true });
}
