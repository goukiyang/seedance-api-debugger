import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';

/** Shared by the candidate fixture and the compatible reader, with synthetic records only. */
export async function checkWorkMethodPin(db: PrismaClient) {
  const { resolveSharedStudioDefinition, resolveSharedStudioModule, studioBindingKey, SHARED_STUDIO_PROTOCOL } = await import('../src/lib/image-studio/shared-contract');
  const actor = { id: `method-pin-${randomUUID()}`, role: 'admin', account_type: 'internal' };
  await db.user.create({ data: { ...actor, name: 'Synthetic method reader', username: actor.id, email: `${actor.id}@example.invalid`, password_hash: 'synthetic-not-a-credential' } });
  const preset = await db.imageStudioPreset.create({ data: { id: randomUUID(), owner_id: actor.id, scope: 'creator', is_shared: true,
    name: 'Synthetic frozen method', model: 'gemini-nano-banana-2.1' } });
  const workspace = await db.imageStudioModule.create({ data: { id: randomUUID(), owner_id: actor.id, source_preset_id: preset.id, name: preset.name } });
  await db.platformSetting.create({ data: { key: studioBindingKey(workspace.id), value_json: JSON.stringify({
    protocol: SHARED_STUDIO_PROTOCOL, ownerId: actor.id, presetId: preset.id, mode: 'live',
  }) } });
  const { definition } = await resolveSharedStudioDefinition(actor, preset.id, db);
  const pin = { ownerId: actor.id, presetId: preset.id, sourceRevision: definition.sourceRevision, definitionToken: definition.intent.definitionToken };
  const key = `studio_works_method_pin_v1:${workspace.id}`;
  await db.platformSetting.create({ data: { key, value_json: JSON.stringify(pin) } });
  assert.ok(await resolveSharedStudioModule(actor, workspace.id, db));
  const before = await db.imageStudioModule.findUniqueOrThrow({ where: { id: workspace.id } });
  await db.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify({ ...pin, definitionToken: 'unmatched-dependency-token' }) } });
  await assert.rejects(resolveSharedStudioModule(actor, workspace.id, db), error => (error as { status?: number }).status === 409);
  await db.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify(pin) } });
  await db.imageStudioPreset.update({ where: { id: preset.id }, data: { name: 'A changed source version', updated_at: new Date(preset.updated_at.getTime() + 1000) } });
  await assert.rejects(resolveSharedStudioModule(actor, workspace.id, db), error => (error as { status?: number }).status === 409);
  assert.deepEqual(await db.imageStudioModule.findUniqueOrThrow({ where: { id: workspace.id } }), before, 'A rejected source version must preserve the personal draft');
  return { exactVersionAccepted: true, dependencyTokenChangedDenied: true, changedSourceDenied: true, personalDraftPreserved: true };
}

async function main() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'works-method-pin-'));
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: `file:${path.join(directory, 'synthetic.db')}`, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  execFileSync(process.execPath, [path.join(process.cwd(), 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(process.cwd(), 'prisma/schema.prisma')], { cwd: directory, env, stdio: 'pipe', timeout: 120000 });
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient(); Reflect.set(globalThis, 'prisma', db); Reflect.set(globalThis, 'prismaSqlitePragmasStarted', true);
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Network prohibited in synthetic method reader check'); };
  try {
    const checks = await checkWorkMethodPin(db); assert.equal(networkCalls, 0);
    const schema = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'));
    console.log(JSON.stringify({ synthetic: true, productionWrites: 0, paidRequests: 0, browserRuns: 0, networkCalls, schemaBytes: schema.length, checks }));
  } finally { await db.$disconnect(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(error); process.exitCode = 1; });
}
