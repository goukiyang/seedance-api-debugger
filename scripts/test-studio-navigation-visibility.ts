import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Run the actual policy against an isolated client. Never import Prisma or open a database.
const source = readFileSync('src/lib/image-studio/navigation-preferences.ts', 'utf8');
const exportsObject = {};
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
  { exports: exportsObject, require: (name: string) => { assert.equal(name, '@/lib/prisma'); return { prisma: new Proxy({}, { get() { throw new Error('Real database access prohibited'); } }) }; } });
const policy = exportsObject as typeof import('../src/lib/image-studio/navigation-preferences');
const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222', foreign = '33333333-3333-4333-8333-333333333333';
const ownership = new Map([[first, 'owner-a'], [second, 'owner-a'], [foreign, 'owner-b']]);
let row: { id: string; user_id: string; key: string; value_json: string } | null = null;
let writes = 0, forceConflict = false;
const client = {
  imageStudioModule: {
    findFirst: async ({ where }: { where: { id: string; owner_id: string } }) => ownership.get(where.id) === where.owner_id ? { id: where.id } : null,
    findMany: async ({ where }: { where: { id: { in: string[] }; owner_id: string } }) => where.id.in.filter(id => ownership.get(id) === where.owner_id).map(id => ({ id })),
  },
  userPreference: {
    findUnique: async ({ where }: { where: { user_id_key: { user_id: string; key: string } } }) => row?.user_id === where.user_id_key.user_id && row.key === where.user_id_key.key ? { ...row } : null,
    create: async ({ data }: { data: { user_id: string; key: string; value_json: string } }) => { assert.equal(row, null); writes++; row = { id: 'preference', ...data }; return row; },
    updateMany: async ({ where, data }: { where: { id: string; user_id: string; key: string; value_json: string }; data: { value_json: string } }) => {
      if (forceConflict || !row || row.id !== where.id || row.user_id !== where.user_id || row.key !== where.key || row.value_json !== where.value_json) return { count: 0 };
      writes++; row = { ...row, ...data }; return { count: 1 };
    },
  },
} as unknown as Parameters<typeof policy.changeStudioNavigationPreference>[0];
const status = (expected: number) => (cause: unknown) => Boolean(cause && typeof cause === 'object' && 'status' in cause && cause.status === expected);
async function main() {
  assert.equal(policy.parseStudioNavigationPreference(null).revision, 0);
  assert.throws(() => policy.parseStudioNavigationPreference('{broken'), status(503));
  assert.throws(() => policy.parseStudioNavigationPreference(JSON.stringify({ version: 99, revision: 2, hiddenModuleIds: [] })), status(503));
  await assert.rejects(policy.changeStudioNavigationPreference(client, 'owner-a', foreign, true, 0), status(404));
  assert.equal(writes, 0, 'cross-owner request cannot write preferences');
  const hidden = await policy.changeStudioNavigationPreference(client, 'owner-a', first, true, 0);
  assert.equal(hidden.revision, 1); assert.deepEqual(Array.from(hidden.hiddenModuleIds), [first]);
  assert.equal(row!.key, policy.STUDIO_NAVIGATION_PREFERENCE_KEY);
  await assert.rejects(policy.changeStudioNavigationPreference(client, 'owner-a', second, true, 0), status(409));
  assert.equal(writes, 1, 'stale revision cannot overwrite hidden entries');
  await policy.changeStudioNavigationPreference(client, 'owner-a', second, true, 1);
  forceConflict = true;
  await assert.rejects(policy.changeStudioNavigationPreference(client, 'owner-a', first, false, 2), status(409));
  assert.equal(writes, 2, 'failed raw-value CAS cannot write');
  forceConflict = false;
  const restored = await policy.changeStudioNavigationPreference(client, 'owner-a', first, false, 2);
  assert.equal(restored.revision, 3); assert.deepEqual(Array.from(restored.hiddenModuleIds), [second]);
  await policy.changeStudioNavigationPreference(client, 'owner-a', first, false, 3);
  assert.equal(writes, 3, 'already-restored request does not create a new mutation');
  assert.equal(ownership.size, 3, 'navigation changes never remove modules');
  row = { ...row!, value_json: JSON.stringify({ version: 1, revision: 4, hiddenModuleIds: [second, foreign] }) };
  const projected = await policy.readStudioNavigationPreference('owner-a', client);
  assert.deepEqual(Array.from(projected.hiddenModuleIds), [second], 'read projects only owned IDs');
  assert.equal(projected.revision, 4);
  assert.equal((await policy.readStudioNavigationPreference('owner-b', client)).hiddenModuleIds.length, 0, 'other account cannot receive this preference');
  row = { ...row!, value_json: '{broken' };
  await assert.rejects(policy.changeStudioNavigationPreference(client, 'owner-a', second, false, 0), status(503));
  assert.equal(row.value_json, '{broken', 'corrupt preference is preserved instead of overwritten');
  assert.equal(writes, 3);
  console.log('PASS isolated navigation visibility ownership, CAS, restoration and data preservation');
}
void main().catch(cause => { console.error(cause); process.exitCode = 1; });
