import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStudioSettingsController, studioSettingsDirty, type SettingsValue, type SettingsWrite } from '../src/app/image-studio/settings-controller';
import { prisma } from '../src/lib/prisma';
import { getImageStudioSettings, saveImageStudioSettings, imageStudioSettingsPayload, StudioSettingsClearConfirmationError } from '../src/lib/image-studio/settings';
import { defaultStudioTemplateDefaults } from '../src/lib/image-studio/template-defaults';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const fixture = (revision = 22, context = 'Current global context'): SettingsValue => ({
  context, revision, prices: { test: 20 }, providerReady: true, contextConfigured: Boolean(context), templateDefaults: defaultStudioTemplateDefaults(),
});

async function main() {
  if (!process.env.DATABASE_URL?.startsWith('file:/tmp/sd2-image-studio-test-')) throw new Error('Use an isolated /tmp/sd2-image-studio-test-* database');
  const slow = deferred<SettingsValue>();
  const writes: SettingsWrite[] = [];
  let server = fixture();
  const controller = createStudioSettingsController(true, {
    read: () => slow.promise,
    write: async payload => { writes.push(payload); server = { ...server, ...payload, revision: server.revision + 1 }; return server; },
  });
  const pending = controller.load();
  controller.editContext('');
  controller.editPrice('test', 5);
  await controller.save();
  assert.equal(writes.length, 0, 'an incomplete first GET cannot become a write');
  assert.equal(controller.getSnapshot().draft, null, 'no fabricated empty draft before loading');
  const unsubscribeFirstModule = controller.subscribe(() => {});
  unsubscribeFirstModule();
  const unsubscribeNextModule = controller.subscribe(() => {});
  slow.resolve(server);
  await pending;
  assert.equal(controller.getSnapshot().draft?.context, server.context, 'changing template subscribers cannot own or reset the global draft');
  await controller.save();
  assert.equal(writes.length, 0, 'initialization is not an edit');
  controller.editPrice('test', 30);
  await controller.save();
  assert.equal(writes.length, 1);
  assert.ok(!Object.hasOwn(writes[0], 'context'), 'a price-only update cannot overwrite context');
  assert.equal(controller.getSnapshot().settings?.context, 'Current global context');
  controller.editContext('');
  await controller.save();
  assert.equal(writes[1].context, '');
  assert.equal(writes[1].confirmContextClear, true, 'a loaded user edit can explicitly clear');
  assert.equal(controller.getSnapshot().settings?.contextConfigured, false);
  assert.equal(studioSettingsDirty(controller.getSnapshot()), false);
  unsubscribeNextModule();

  const first = deferred<SettingsValue>(), second = deferred<SettingsValue>();
  let reads = 0;
  const reorder = createStudioSettingsController(true, {
    read: () => (++reads === 1 ? first.promise : second.promise), write: async () => { throw new Error('unexpected write'); },
  });
  const firstRead = reorder.load();
  reorder.cancelRead();
  const secondRead = reorder.load();
  second.resolve(fixture(24, 'Fresh context'));
  await secondRead;
  first.resolve(fixture(21, ''));
  await firstRead;
  assert.equal(reorder.getSnapshot().draft?.context, 'Fresh context', 'a late GET cannot restore an old empty value');

  let fail = true;
  const conflicting = createStudioSettingsController(true, {
    read: async () => fixture(),
    write: async payload => { if (fail) throw new Error('revision conflict'); return { ...fixture(), ...payload, revision: 23 }; },
  });
  await conflicting.load();
  conflicting.editContext('Unsaved draft');
  await conflicting.save();
  assert.equal(conflicting.getSnapshot().draft?.context, 'Unsaved draft');
  assert.equal(conflicting.getSnapshot().settings?.revision, 22, 'a conflict cannot silently advance the draft baseline');
  await conflicting.load();
  assert.equal(conflicting.getSnapshot().draft?.context, 'Unsaved draft', 'automatic reload preserves edits');
  fail = false;
  await conflicting.save();
  assert.equal(studioSettingsDirty(conflicting.getSnapshot()), false, 'failed saves remain retryable');
  conflicting.editContext('Discard only after confirmation');
  await conflicting.load(true);
  assert.equal(conflicting.getSnapshot().draft?.context, fixture().context);

  const writing = deferred<SettingsValue>();
  const editingDuringSave = createStudioSettingsController(true, { read: async () => fixture(), write: () => writing.promise });
  await editingDuringSave.load();
  editingDuringSave.editContext('First edit');
  const saving = editingDuringSave.save();
  editingDuringSave.editContext('Second edit');
  writing.resolve(fixture(23, 'First edit'));
  await saving;
  assert.equal(editingDuringSave.getSnapshot().draft?.context, 'Second edit');
  assert.ok(studioSettingsDirty(editingDuringSave.getSnapshot()), 'save completion cannot lose later edits');

  const failedRead = createStudioSettingsController(true, { read: async () => { throw new Error('offline'); }, write: async () => { throw new Error('unexpected write'); } });
  await failedRead.load();
  failedRead.editContext('');
  await failedRead.save();
  assert.equal(failedRead.getSnapshot().draft, null);

  const initial = await getImageStudioSettings();
  const configured = await saveImageStudioSettings({ ...initial, context: 'Admin-only context' }, 'settings-test-admin');
  assert.ok(configured);
  const regularPayload = imageStudioSettingsPayload(configured, false);
  assert.ok(!Object.hasOwn(regularPayload, 'context'));
  assert.equal(regularPayload.contextConfigured, true);
  assert.equal(imageStudioSettingsPayload(configured, true).context, 'Admin-only context');
  await assert.rejects(saveImageStudioSettings({ ...configured, context: '' }, 'settings-test-admin'), StudioSettingsClearConfirmationError);
  assert.equal((await getImageStudioSettings()).context, 'Admin-only context');
  assert.equal(await saveImageStudioSettings(initial, 'settings-test-admin', { confirmContextClear: true }), null, 'stale revisions still fail');
  const cleared = await saveImageStudioSettings({ ...configured, context: '' }, 'settings-test-admin', { confirmContextClear: true });
  assert.equal(cleared?.context, '');
  assert.deepEqual(cleared?.prices, configured.prices);

  const studio = await readFile(new URL('../src/app/image-studio/studio.tsx', import.meta.url), 'utf8');
  const block = studio.slice(studio.indexOf('function ImageStudioBlock'));
  assert.ok(!block.includes('useStudioSettings('), 'global state must not be tied to a template block');
  assert.ok(!block.includes('/api/image-studio/settings'), 'template blocks must not issue independent settings writes');
  assert.equal(studio.match(/useStudioSettings\(userId, isAdmin\)/g)?.length, 1);
  console.log('PASS: slow/late GET, template-independent draft, price-only write, deliberate clear, conflicts/retry, edits during save, admin-only payload and atomic clear protection. Isolated DB; no paid generation.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
