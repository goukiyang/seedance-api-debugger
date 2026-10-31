import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'image-personal-prompt-')));
chmodSync(fixture, 0o700);
const write = (file: string, value: unknown) => writeFileSync(file,
  typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });

async function main() {
  try {
  const keys = Object.fromEntries(['body', 'index', 'backup'].map(domain => {
    const file = path.join(fixture, `${domain}.key`);
    write(file, randomBytes(32));
    return [domain, { active: domain, files: { [domain]: file } }];
  }));
  const origins = [
    { ownerId: 'owner-a', id: 'module-a', kind: 'image-module' },
    { kind: 'image-module', id: 'module-b', ownerId: 'owner-a' },
    { kind: 'image-preset', id: 'preset-a', ownerId: 'owner-a' },
    { kind: 'image-module', id: 'foreign-module', ownerId: 'owner-b' },
  ];
  const policyFile = path.join(fixture, 'policy.json');
  write(policyFile, {
    schema: 'private-prompt-policy.v1', revision: 'image-personal-prompt-fixture', state: 'compatible-read', minimumReader: 1,
    identities: [], origins, authorKinds: [], keys, destinations: [], consumers: ['fixture'],
  });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PRIVATE_PROMPTS_FIXTURE_ROOT: fixture,
    PRIVATE_PROMPTS_POLICY_FILE: policyFile,
    PRIVATE_PROMPTS_MIN_STATE: 'compatible-read',
    PRIVATE_PROMPTS_CONSUMER_ID: 'fixture',
  });

  const crypto = await import('../src/lib/security/private-prompts.server');
  const personal = await import('../src/lib/image-studio/personal-prompt');
  const restored = await import('../src/lib/image-studio/restored-settings');
  const server = await import('../src/lib/image-studio/personal-prompt.server');
  const owner = 'owner-a', taskId = 'ordinary-task-a', moduleOrigin = origins[0];
  const plain = '本人旧普通任务的个人补充';
  const snapshotBinding = { kind: 'image-task-snapshot', id: taskId, field: 'prompt', origins: [moduleOrigin] };
  const taskBinding = { kind: 'image-task', id: taskId, field: 'prompt', origins: [moduleOrigin] };
  const cipher = crypto.sealPrivatePrompt(plain, snapshotBinding);
  const taskCipher = crypto.sealPrivatePrompt(plain, taskBinding);
  const task = (snapshot: Record<string, unknown>, patch: Partial<{ id: string; owner_id: string; prompt: string; snapshot_json: string | null }> = {}) => ({
    id: taskId, owner_id: owner, prompt: taskCipher, snapshot_json: JSON.stringify(snapshot), ...patch,
  });
  const noCipher = (value: unknown, ...forbidden: string[]) => {
    const text = JSON.stringify(value);
    assert.equal(text.includes('ppenc:'), false);
    for (const item of forbidden) assert.equal(text.includes(item), false);
  };

  const recorded = personal.studioPersonalPromptProjection({ personalPrompt: '本次明文补充', prompt: '受保护执行提示' });
  assert.deepEqual(recorded, { personalPromptState: 'recorded', personalPrompt: '本次明文补充' });
  const legacy = personal.studioPersonalPromptProjection({ prompt: '旧明文补充' });
  assert.deepEqual(legacy, { personalPromptState: 'legacy-personal', personalPrompt: '旧明文补充' });
  const recordedSnapshot = { moduleId: moduleOrigin.id, sourcePresetId: null, personalPrompt: '本次明文补充', prompt: '受保护执行提示' };
  assert.deepEqual(server.serverStudioPersonalPromptProjection(task(recordedSnapshot), recordedSnapshot, owner), recorded);
  assert.equal(server.serverStudioPersonalPromptProjection(task(recordedSnapshot), recordedSnapshot, 'other-owner').personalPromptState, 'unavailable');
  const legacySnapshot = { moduleId: moduleOrigin.id, sourcePresetId: null, prompt: '旧明文补充' };
  assert.deepEqual(server.serverStudioPersonalPromptProjection(task(legacySnapshot), legacySnapshot, owner), legacy);
  assert.equal(server.serverStudioPersonalPromptProjection(task(legacySnapshot), legacySnapshot, 'other-owner').personalPromptState, 'unavailable');
  assert.equal(personal.isEncryptedStudioPersonalPrompt(cipher), true);
  assert.equal(personal.isEncryptedStudioPersonalPrompt(cipher.slice('ppenc:v1:'.length)), true);
  assert.equal(personal.isEncryptedStudioPersonalPrompt(JSON.parse(cipher.slice('ppenc:v1:'.length))), true);
  assert.equal(personal.isEncryptedStudioPersonalPrompt('{"format":"private-prompt.v1","ciphertext":'), true);
  assert.equal(personal.isEncryptedStudioPersonalPrompt('普通文本 private-prompt.v1'), false);
  assert.deepEqual(personal.studioPersonalPromptProjection({ prompt: cipher }), { personalPromptState: 'unknown' });
  assert.deepEqual(personal.studioPersonalPromptProjection({ personalPrompt: cipher }), { personalPromptState: 'unknown' });

  const ordinarySnapshot = { version: 1, moduleId: moduleOrigin.id, sourcePresetId: null, prompt: cipher };
  const recovered = server.serverStudioPersonalPromptProjection(task(ordinarySnapshot), ordinarySnapshot, owner);
  assert.deepEqual(recovered, { personalPromptState: 'legacy-personal', personalPrompt: plain });
  noCipher(recovered, cipher);

  const denied = server.serverStudioPersonalPromptProjection(task(ordinarySnapshot), ordinarySnapshot, 'other-owner');
  assert.equal(denied.personalPromptState, 'unavailable');
  assert.equal(typeof denied.personalPromptReason, 'string');
  assert.equal(Object.hasOwn(denied, 'personalPrompt'), false);
  noCipher(denied, cipher);

  const wrongTaskCipher = crypto.sealPrivatePrompt(plain,
    { ...snapshotBinding, id: 'other-task' });
  const wrongTask = { ...ordinarySnapshot, prompt: wrongTaskCipher };
  const wrongTaskResult = server.serverStudioPersonalPromptProjection(task(wrongTask), wrongTask, owner);
  assert.equal(wrongTaskResult.personalPromptState, 'unavailable');
  noCipher(wrongTaskResult, wrongTaskCipher);

  const wrongOriginCipher = crypto.sealPrivatePrompt(plain,
    { ...snapshotBinding, origins: [origins[1]] });
  const wrongOrigin = { ...ordinarySnapshot, prompt: wrongOriginCipher };
  const wrongOriginResult = server.serverStudioPersonalPromptProjection(task(wrongOrigin), wrongOrigin, owner);
  assert.equal(wrongOriginResult.personalPromptState, 'unavailable');
  noCipher(wrongOriginResult, wrongOriginCipher);

  const foreignOriginCipher = crypto.sealPrivatePrompt(plain,
    { ...snapshotBinding, origins: [origins[3]] });
  const foreignOrigin = { ...ordinarySnapshot, moduleId: origins[3].id, prompt: foreignOriginCipher };
  const foreignOriginResult = server.serverStudioPersonalPromptProjection(task(foreignOrigin), foreignOrigin, owner);
  assert.equal(foreignOriginResult.personalPromptState, 'unavailable');
  assert.equal(Object.hasOwn(foreignOriginResult, 'personalPrompt'), false);
  noCipher(foreignOriginResult, foreignOriginCipher);

  const missingOrigin = { version: 1, moduleId: moduleOrigin.id, prompt: cipher };
  assert.equal(server.serverStudioPersonalPromptProjection(task(missingOrigin), missingOrigin, owner).personalPromptState, 'unavailable');
  assert.equal(server.serverStudioPersonalPromptProjection(task(ordinarySnapshot), { ...ordinarySnapshot, count: 2 }, owner).personalPromptState, 'unavailable');

  const shared = { ...ordinarySnapshot, sharedLive: { protocol: 'shared-live-v1', presetId: 'preset-a' }, templatePrompt: '模板提示' };
  const restoredMixed = { ...ordinarySnapshot, restoredSettings: { protocol: 'task-settings-v1', sourceTaskId: 'source-task' }, templatePrompt: '模板提示' };
  for (const snapshot of [shared, restoredMixed]) {
    const output = server.serverStudioPersonalPromptProjection(task(snapshot), snapshot, owner);
    assert.equal(output.personalPromptState, 'unavailable');
    assert.equal(Object.hasOwn(output, 'personalPrompt'), false);
    noCipher(output, cipher);
  }
  for (const snapshot of [
    { ...shared, personalPrompt: '共享任务的独立明文补充' },
    { ...restoredMixed, personalPrompt: '恢复任务的独立明文补充' },
  ]) {
    const output = server.serverStudioPersonalPromptProjection(task(snapshot), snapshot, owner);
    assert.equal(output.personalPromptState, 'recorded');
    assert.equal(output.personalPrompt, snapshot.personalPrompt);
    noCipher(output, cipher);
  }

  for (const malformed of ['ppenc:v1:{not-json', '{"format":"private-prompt.v1","ciphertext":']) {
    const snapshot = { version: 1, moduleId: moduleOrigin.id, sourcePresetId: null, prompt: malformed };
    assert.deepEqual(personal.studioPersonalPromptProjection(snapshot), { personalPromptState: 'unknown' });
    const output = server.serverStudioPersonalPromptProjection(task(snapshot), snapshot, owner);
    assert.equal(output.personalPromptState, 'unavailable');
    assert.equal(Object.hasOwn(output, 'personalPrompt'), false);
    noCipher(output, malformed);
  }

  assert.throws(() => restored.restoredStudioTemplatePrompt({ templatePrompt: cipher }), restored.RestoredStudioSettingsError);
  assert.throws(() => restored.restoredStudioTemplatePrompt({ templatePrompt: '{"format":"private-prompt.v1","ciphertext":' }), restored.RestoredStudioSettingsError);
  assert.equal(restored.restoredStudioTemplatePrompt({ templatePrompt: '可恢复的明文模板' }), '可恢复的明文模板');

  const absent = { version: 1, moduleId: moduleOrigin.id, sourcePresetId: null };
  const absentOutput = server.serverStudioPersonalPromptProjection(task(absent), absent, owner);
  assert.equal(absentOutput.personalPromptState, 'unknown');
  assert.equal(typeof absentOutput.personalPromptReason, 'string');
  noCipher(absentOutput);

  console.log(JSON.stringify({
    schema: 'image-personal-prompt-engineering.v1',
    passed: true,
    checks: [
      'recorded-and-legacy-plaintext', 'encrypted-envelope-detection', 'owner-original-binding-recovery', 'canonical-policy-origin-order',
      'wrong-owner-binding-origin', 'shared-restored-separation', 'malformed-cipher-redaction',
      'template-cipher-redaction', 'dto-never-returns-ciphertext',
    ],
    productionWrites: 0, networkCalls: 0, browserRuns: 0, paidRequests: 0,
  }));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
