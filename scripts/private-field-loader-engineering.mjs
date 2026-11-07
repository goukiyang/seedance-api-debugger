import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(os.tmpdir(), 'private-loader-fixture-'));
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${directory}/unused.sqlite` });
for (const name of Object.keys(process.env).filter(name => name.startsWith('PRIVATE_PROMPTS_'))) delete process.env[name];
globalThis.prismaSqlitePragmasStarted = true;
const require = createRequire(import.meta.url);
try {
  const cjs = require('../src/lib/security/private-prompt-fields.server.ts');
  const esm = await import('../src/lib/security/private-prompt-fields.server.ts');
  const raw = { context: '' };
  const view = cjs.readPrivateFields(raw, 'image-task', 'fixture', [{ field: 'context', origins: [] }]);
  assert.equal(esm.privateStoredValue(view), raw);
  const cjsStorage = require('../src/lib/image-studio/private-storage.server.ts');
  const esmStorage = await import('../src/lib/image-studio/private-storage.server.ts');
  const task = { id: 'loader-task', owner_id: 'fixture', prompt: '', context: '', snapshot_json: JSON.stringify({ moduleContext: '' }) };
  const decoded = cjsStorage.transformPrivateImageTask(task, false);
  assert.equal(esm.privateStoredValue(decoded), task);
  assert.deepEqual(esmStorage.readPrivateImageTaskSnapshot(decoded), { moduleContext: '' });
  const cjsErrors = require('../src/lib/security/private-prompts.server.ts');
  const esmErrors = await import('../src/lib/security/private-prompts.server.ts');
  assert.equal(esmErrors.isPrivatePromptError(new cjsErrors.PrivatePromptError()), true);
  assert.equal(cjsErrors.isPrivatePromptError(new esmErrors.PrivatePromptError()), true);
  assert.equal(esmErrors.isPrivatePromptError(Object.assign(new Error('ordinary'), { code: 'PRIVATE_PROMPT_UNAVAILABLE', status: 503 })), false);
  console.log(JSON.stringify({ passed: true, checks: 6, realCommonJsAndEsm: true, productionWrites: 0, paidRequests: 0 }));
} finally {
  await globalThis.prisma?.$disconnect();
  rmSync(directory, { recursive: true, force: true });
}
