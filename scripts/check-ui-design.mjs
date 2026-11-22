import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, webcrypto, createHash } from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = process.cwd(), packagePath = path.join(root, '.private/ui-design', 'ec22430289417474f6a64710bb58f8a261f901493af89ffc6053c3209444561a');
const evidence = await fs.mkdtemp(path.join(root, '.private/ui-design/engineering-'));
const databaseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sd2-ui-design-engineering-'));
await fs.writeFile(path.join(databaseDirectory, 'isolated.db'), '');
process.env.DATABASE_URL = `file:${path.join(databaseDirectory, 'isolated.db')}`;
process.env.UI_DESIGN_PACKAGE = packagePath;
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });
const moduleApi = createRequire(import.meta.url)('node:module');
const resolveModule = moduleApi._resolveFilename;
const serverMarker = path.join(path.dirname(createRequire(import.meta.url).resolve('next/package.json')), 'dist/compiled/server-only/empty.js');
moduleApi._resolveFilename = function (id, ...args) { return id === 'server-only' ? serverMarker : resolveModule.call(this, id, ...args); };
const { prisma } = await import('../src/lib/prisma.ts');
const store = await import('../src/lib/ui-design/store.ts');
const media = await import('../src/lib/ui-design/media.ts');
const runtime = await import('../src/lib/ui-design/runtime.ts');
const generation = await import('../src/lib/ui-design/generation.ts');
const { uiUser } = await import('../src/lib/ui-design/access.ts');
const { NextRequest } = await import('next/server.js');
const { convertUiAnalysisTurn } = await import('../src/lib/ui-design/analysis.ts');
const { closeStudioSubmission, readStudioSubmitReceipt } = await import('../src/lib/image-studio/submit-receipts.server.ts');
const require = createRequire(path.join(packagePath, 'index.html'));
const SI = require(path.join(packagePath, 'structure-images.js'));
const A = require(path.join(packagePath, 'structure-plans.js'));
const originalAnalysis = require(path.join(packagePath, 'codex-design-analysis.cjs'));
const manifest = await runtime.privateManifest();
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS', name); };
const user = { id: randomUUID(), name: 'Engineering fixture', username: randomUUID(), email: `${randomUUID()}@example.invalid`, password_hash: 'not-a-login-password', role: 'user', account_type: 'internal', status: 'active', user_profile: 'other', feature_profile_id: 'internal_email_authorized', expires_at: null };
const other = { ...user, id: randomUUID(), username: randomUUID(), email: `${randomUUID()}@example.invalid` };
await prisma.user.create({ data: user }); await prisma.user.create({ data: other });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=';
await fs.mkdir(path.join(root, 'storage'), { recursive: true, mode: 0o700 });
try {
  await check('session admission, origin and account binding ignore legacy identity headers', async () => {
    const request = headers => new NextRequest('http://internal-server/api/tools/ui-design/workspace', { method: 'POST', headers: { host: 'local', ...headers } });
    assert.equal((await uiUser(request({ origin: 'http://local', 'x-uiux-user': other.id }), async () => user)).id, user.id);
    for (const [session, headers, status] of [[null, { origin: 'http://local' }, 401], [{ ...user, account_type: 'external' }, { origin: 'http://local' }, 403], [{ ...user, status: 'disabled' }, { origin: 'http://local' }, 403], [user, { origin: 'http://elsewhere' }, 403], [user, { origin: 'http://local', 'x-ui-design-account': other.id }, 409]]) {
      await assert.rejects(() => uiUser(request(headers), async () => session), error => error.status === status);
    }
  });
  await check('private manifest and runtime file boundary', async () => {
    assert.deepEqual(manifest.counts, { plans: 7, rawFrames: 191, selectableFrames: 181, images: 565 });
    for (const name of ['../index.html', 'codex-design-analysis.cjs', 'library/UIUX-ART.uiuxworkspace', 'node_modules/pdfjs-dist/package.json']) await assert.rejects(() => runtime.packageFile(name, true));
    assert.ok((await runtime.packageFile('index.html', true)).length > 0);
  });
  await check('owner records, pagination, CAS and archive keep receipts', async () => {
    const id = randomUUID(), first = await store.saveUiDocument(user.id, 'workspace', id, 0, { name: 'first', state: { brief: 'saved' } });
    await assert.rejects(() => store.readUiDocument(other.id, 'workspace', id));
    const raced = await Promise.allSettled([store.saveUiDocument(user.id, 'workspace', id, first.revision, { name: 'one' }), store.saveUiDocument(user.id, 'workspace', id, first.revision, { name: 'two' })]);
    assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
    for (let i = 0; i < 22; i++) await store.saveUiDocument(user.id, 'workspace', randomUUID(), 0, { name: `page ${i}` });
    const firstPage = await store.listUiDocuments(user.id, 'workspace'); assert.equal(firstPage.records.length, 20); assert.ok(firstPage.nextCursor);
    assert.ok((await store.listUiDocuments(user.id, 'workspace', firstPage.nextCursor)).records.length >= 3);
    await store.saveUiDocument(user.id, 'request', id, 0, { state: 'unknown' });
    const current = await store.readUiDocument(user.id, 'workspace', id); await store.saveUiDocument(user.id, 'workspace', id, current.revision, current.data, true);
    assert.equal((await store.readUiDocument(user.id, 'request', id)).data.state, 'unknown');
  });
  let restored, registered;
  await check('actual adapter persistence restores uploaded structure and analysis input', async () => {
    const library = (await runtime.sourceLibrary()).map(plan => JSON.parse(JSON.stringify(plan).replaceAll('/api/figma-assets/', '/api/tools/ui-design/library?asset=')));
    const local = new Map(), drafts = new Map(), source = SI.createSource('Own interaction', [{ name: 'Own.png', width: 1, height: 1, dataUrl: png }]);
    // Only the IndexedDB transport is substituted here; real browser storage is checked separately.
    const indexedDB = { open() {
      const request = { result: { transaction() {
        const transaction = { pending: 0 };
        const schedule = operation => {
          const request = {}; transaction.pending++;
          setTimeout(() => { request.result = structuredClone(operation()); request.onsuccess?.(); if (!--transaction.pending) transaction.oncomplete?.(); }, 0);
          return request;
        };
        transaction.objectStore = () => ({ get: key => schedule(() => drafts.get(key)), put: (value, key) => schedule(() => { drafts.set(key, structuredClone(value)); return key; }), delete: key => schedule(() => drafts.delete(key)) });
        return transaction;
      } } };
      setTimeout(() => request.onsuccess?.(), 0); return request;
    } };
    const state = { provider: 'sd2', source: null, structurePlans: [], messages: [], runs: [], brief: 'Own UI brief', visual: { samples: [], sources: [] }, designIntent: { mode: 'redesign', guidance: '' } };
    A.importSource(state, source, '');
    const id = randomUUID();
    let workspaceUnavailable = false;
    const fetcher = async (url, init = {}) => {
      const parsed = new URL(url, 'http://local'), body = init.body ? JSON.parse(init.body) : undefined;
      let result;
      try {
        if (parsed.pathname.endsWith('/bootstrap')) result = { user, sourceVersion: manifest.sourceSha256, history: { records: [], nextCursor: null } };
        else if (parsed.pathname.endsWith('/media')) { registered = await media.registerUiImage(user, body); result = registered; }
        else if (parsed.pathname.endsWith('/library')) result = body ? await store.saveUiDocument(user.id, 'library', body.id, body.revision, body.data) : parsed.searchParams.has('id') ? await store.readUiDocument(user.id, 'library', parsed.searchParams.get('id')) : { library };
        else {
          if (body && workspaceUnavailable) throw new Error('isolated workspace outage');
          result = body ? await store.saveUiDocument(user.id, 'workspace', body.id, body.revision, body.data) : await store.readUiDocument(user.id, 'workspace', parsed.searchParams.get('id'));
        }
        return new Response(JSON.stringify(result));
      } catch (error) { return new Response(JSON.stringify({ error: error.message }), { status: error.status || 503 }); }
    };
    const context = { indexedDB, crypto: webcrypto, structuredClone, URL, Response, setTimeout, clearTimeout, queueMicrotask, console,
      location: { origin: 'http://local' }, document: { getElementById: () => null }, addEventListener() {}, fetch: fetcher,
      localStorage: { getItem: key => local.get(key) || null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) },
      FrameformStructurePlans: A, parent: { postMessage() {} } };
    context.window = context; context.globalThis = context;
    vm.runInNewContext(await fs.readFile(path.join(packagePath, 'sd2-adapter.js'), 'utf8'), context);
    const adapter = context.UIUXTeam; await adapter.load();
    await adapter.save({ schema: 1, state, conversationId: id, conversations: [], structureLibrary: A.librarySnapshot(state) });
    const persisted = await store.readUiDocument(user.id, 'workspace', id);
    assert.ok(!JSON.stringify(persisted.data).includes('data:image/'));
    restored = (await adapter.open(id)).state;
    assert.ok(SI.isSource(restored.source)); assert.equal(A.targets(restored).length, 1);
    assert.equal((await media.registerUiImage(user, { dataUrl: SI.frameImage(A.targets(restored)[0]) })).assetId, registered.assetId);
    assert.ok(SI.frameImage(A.targets(restored)[0]).startsWith('/api/tools/ui-design/media?id='));
    const { asset, bytes } = await media.uiImageBytes(user, registered.assetId);
    const dataUrl = `data:${asset.mime_type};base64,${bytes.toString('base64')}`;
    const frames = A.targets(restored).map(frame => ({ id: frame.id, name: frame.name, w: frame.w, h: frame.h, sourceFacts: '', notes: [] }));
    const prepared = originalAnalysis.prepareAnalysisRequest({ mode: 'redesign', description: 'Create a family game menu', guidance: '', frames, samples: [{ label: 'Style', dataUrl }], structures: [{ frameId: frames[0].id, label: 'Structure', provenance: 'uploaded-original', dataUrl }] });
    const messages = await convertUiAnalysisTurn(prepared.request, user.id);
    const parts = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    assert.equal(parts.filter(part => part.type === 'image_url').length, 2);
    assert.deepEqual(messages.filter(message => typeof message.content === 'string').map(message => message.content), prepared.request.input.filter(item => item.type === 'text').map(item => item.text));
    await assert.rejects(() => media.uiImageBytes(other, registered.assetId));
    const node = { textContent: '', dataset: {}, closest() { return this; } };
    context.document.getElementById = id => id.startsWith('sd2-') ? null : node;
    context.document.querySelectorAll = () => [];
    let importedCurrent, importedHistory, importedWorkspaceId;
    await adapter.bind({ get: () => ({ state: { runs: [] } }), persist: async () => {},
      importRecord: async record => { importedCurrent = record; importedWorkspaceId = randomUUID(); await adapter.save({ state: record.state, conversationId: importedWorkspaceId, structureLibrary: record.library }); },
      history: async records => { importedHistory = records; } });
    const beforeIds = A.librarySnapshot(restored).map(plan => plan.id);
    const legacy = structuredClone(state);
    legacy.runs = [{ id: 'original-external-run', provider: 'lovart', requestId: 'original-external-request', jobs: [] }];
    await adapter.importArchive({ schema: 1, state, structureLibrary: A.librarySnapshot(state), conversations: [{ id: 'old-conversation', state: legacy }] }, 'Imported copy');
    assert.ok(beforeIds.every(id => importedCurrent.library.some(plan => plan.id === id)));
    assert.equal(importedHistory.length, 1); assert.notEqual(importedHistory[0].id, 'old-conversation');
    const importedSaved = (await adapter.open(importedHistory[0].id)).state;
    assert.equal(importedSaved.runs[0].provider, 'lovart'); assert.equal(importedSaved.runs[0].requestId, 'original-external-request');
    assert.ok(!JSON.stringify((await store.readUiDocument(user.id, 'workspace', importedHistory[0].id)).data).includes('data:image/'));
    adapter.restoreBinding({ projectId: 'captured-project', controls: { analysisModel: 'captured-text', settings: { model: 'captured-image' } } });
    const capturedId = randomUUID(), saving = adapter.save({ state: restored, conversationId: capturedId, structureLibrary: A.librarySnapshot(restored) });
    adapter.restoreBinding({ projectId: 'other-project', controls: { settings: { model: 'other-image' } } });
    await saving;
    const captured = await store.readUiDocument(user.id, 'workspace', capturedId);
    assert.equal(captured.data.projectId, 'captured-project'); assert.equal(captured.data.controls.settings.model, 'captured-image');
    workspaceUnavailable = true;
    const draftState = structuredClone(restored); draftState.brief = 'failed save retained'; draftState.visual.samples = [{ assetId: registered.assetId, dataUrl: registered.url }];
    await assert.rejects(() => adapter.save({ state: draftState, conversationId: capturedId, structureLibrary: A.librarySnapshot(restored) }));
    assert.equal((await adapter.open(capturedId)).state.visual.samples[0].assetId, registered.assetId);
    workspaceUnavailable = false;
    const fresh = await store.readUiDocument(user.id, 'workspace', capturedId);
    await store.saveUiDocument(user.id, 'workspace', capturedId, fresh.revision, { ...fresh.data, name: 'other page' });
    await assert.rejects(() => adapter.save({ state: draftState, conversationId: capturedId, structureLibrary: A.librarySnapshot(restored) }), error => error.statusCode === 409);
    await adapter.open(capturedId);
    await assert.rejects(() => adapter.save({ state: draftState, conversationId: capturedId, structureLibrary: A.librarySnapshot(restored) }), error => error.statusCode === 409);
    assert.equal((await store.readUiDocument(user.id, 'workspace', capturedId)).data.name, 'other page');
    checks.push('queued save freezes controls; failed full draft and persistent CAS conflict retained');
    const originalPlan = library[0], originalFrame = originalPlan.source.frames[0];
    for (const info of [{ planId: originalPlan.id }, { planId: randomUUID(), sourceId: originalPlan.source.id, version: manifest.sourceSha256 }]) {
      const restoredFigma = await adapter.deserialize({ __uiFramePart: { ...info, frameId: originalFrame.id, field: 'figma' } });
      assert.deepEqual(restoredFigma, originalFrame.figma);
    }
    const missing = await adapter.deserialize({ __uiFramePart: { planId: randomUUID(), frameId: 'missing', field: 'figma' } });
    assert.equal(missing, null);
    checks.push('old and immutable frame markers survive mutable-library removal; unavailable source preserves document');
    await adapter.importArchive(JSON.parse((await runtime.packageFile('library/UIUX-ART.uiuxworkspace')).toString()), 'Real original import');
    assert.ok(JSON.stringify((await store.readUiDocument(user.id, 'workspace', importedWorkspaceId)).data).length < 4_000_000);
    checks.push('real original workspace import remains under 4 MB without resource-ID duplication');
  });
  await check('shared use does not grant copy or original export, and revoke blocks new use', async () => {
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: registered.assetId } });
    await prisma.asset.update({ where: { id: asset.id }, data: { owner_id: other.id } });
    const album = await prisma.referenceAlbum.create({ data: { name: 'Use only', owner_user_id: other.id, visibility: 'shared' } });
    const image = await prisma.referenceImage.create({ data: { album_id: album.id, owner_user_id: other.id, asset_id: asset.id, url: asset.original_url } });
    const share = await prisma.albumShare.create({ data: { album_id: album.id, grantee_type: 'user', grantee_id: user.id, created_by: other.id, permissions_json: JSON.stringify({ view: true, use: true, copy: false, download: false, viewSource: false, edit: false }) } });
    assert.equal((await media.uiUseAsset(user, { assetId: asset.id, referenceImageId: image.id })).owner_id, other.id);
    await assert.rejects(() => media.uiImageBytes(user, asset.id));
    await prisma.albumShare.delete({ where: { id: share.id } });
    await assert.rejects(() => media.uiUseAsset(user, { assetId: asset.id, referenceImageId: image.id }));
  });
  await check('batch CAS dispatches once and original empty receipts remain unknown', async () => {
    const workspaceId = randomUUID(), runId = randomUUID(), id = randomUUID();
    const project = await prisma.project.create({ data: { name: 'Engineering project', type: 'personal', owner_user_id: user.id, created_by: user.id } });
    await store.saveUiDocument(user.id, 'workspace', workspaceId, 0, { projectId: project.id });
    const job = { id, workspaceId, frameId: 'fixture-screen', runId, inputHash: 'frozen-fixture-input', body: { requestId: id, projectId: project.id }, references: [], context: '', state: 'prepared', quote: { estimatedCredits: 1, expiresAt: new Date(Date.now() + 60000).toISOString() } };
    await store.saveUiDocument(user.id, 'request', id, 0, job);
    await store.saveUiDocument(user.id, 'batch', runId, 0, { id: runId, workspaceId, jobs: [job], inputHash: 'batch-fixture-input', total: 1, confirmed: true, stopped: false });
    let calls = 0;
    const send = async () => { calls++; return createHash('sha256').update(`${user.id}:${id}`).digest('hex'); };
    const input = { requestId: id, runId, inputHash: job.inputHash, batchHash: 'batch-fixture-input' };
    await Promise.allSettled([generation.submitUiJob(user, input, send), generation.submitUiJob(user, input, send)]);
    assert.equal(calls, 1);
    await generation.submitUiJob(user, input, send); assert.equal(calls, 1);
    await assert.rejects(() => generation.submitUiJob(user, { ...input, inputHash: 'changed' }, send));
    assert.equal((await readStudioSubmitReceipt(user.id, id)).state, 'unknown');
    const empty = randomUUID(); assert.equal((await closeStudioSubmission(user.id, empty)).state, 'closed');
    const writable = await import('../src/lib/image-studio/submit-receipts.server.ts'); await assert.rejects(() => writable.assertStudioRequestWritable(prisma, user.id, empty));
    await assert.rejects(() => generation.confirmUiBatch(user, { runId, revision: 1, inputHash: 'stale', total: 1 }));
  });
  await check('real shared preparation isolates UI context and preserves ordered references and ordinary defaults', async () => {
    const settings = await import('../src/lib/image-studio/settings.ts');
    const integration = await import('../src/lib/integrations/image-generation.ts');
    const tasks = await import('../src/lib/image-studio/tasks.ts');
    await prisma.creditAccount.create({ data: { user_id: user.id, balance: 100 } });
    const ids = [randomUUID(), randomUUID(), randomUUID()], fixed = randomUUID();
    await prisma.asset.createMany({ data: [...ids, fixed].map(id => ({ id, owner_id: user.id, type: 'image', original_url: `/fixture/${id}.png`, file_name: `${id}.png`, mime_type: 'image/png', width: 32, height: 32, file_size: 128, hash: id, status: 'active' })) });
    const moduleId = `default-${user.id}`;
    await prisma.imageStudioModule.create({ data: { id: moduleId, owner_id: user.id, name: 'Fixture', prompt: 'ORDINARY_TEMPLATE', context: 'ORDINARY_MODULE', model: 'gpt-image-2', revision: 1 } });
    await prisma.platformSetting.createMany({ data: [
      { key: settings.IMAGE_STUDIO_SETTING_KEY, value_json: JSON.stringify({ model: 'gpt-image-2', revision: 7, context: 'ORDINARY_GLOBAL', prices: { ...settings.DEFAULT_STUDIO_PRICES, 'gpt-image-2': 5 } }) },
      { key: integration.IMAGE_GENERATION_API_SETTING_KEY, value_json: JSON.stringify({ ...integration.DEFAULT_IMAGE_GENERATION_API_SETTINGS, enabled: true, provider: 'ai_media_vip', default_model: 'gpt-image-2', base_url: 'https://fixture.invalid/v1/', api_key: 'synthetic-not-a-credential' }) },
      { key: `studio_fixed_references_v1:module:${moduleId}`, value_json: JSON.stringify({ ownerId: user.id, references: [{ assetId: fixed, note: 'ORDINARY_FIXED' }] }) }
    ] });
    const id = randomUUID(), body = { requestId: id, projectId: null, prompt: 'x'.repeat(20000), count: 1, revision: 7, model: 'gpt-image-2', channelId: 'original', quality: 'medium', resolution: '2K', aspectRatio: '1:1', referenceIds: ids, draft: { styleGroupIds: [], skillIds: [], referencePolicy: { primaryIds: ids, primaryMin: 0, primaryMax: 10, auxiliaryMax: 10, styleMax: 10, referenceMax: 10, useFixedReferences: false } } };
    const job = { id, body, context: 'UI_FROZEN_WIREFRAME_STYLE_PREVIOUS', references: ids.map((assetId, index) => ({ assetId, hash: assetId, role: ['wireframe', 'style', 'previous'][index], label: String(index) })) };
    await store.saveUiDocument(user.id, 'request', id, 0, job);
    let frozen;
    await tasks.submitStudioBatch(user.id, body, undefined, { quoteOnly: true, save: async (_tx, value) => { frozen = value; } }, undefined, undefined, undefined, undefined, undefined, { user, requestId: id });
    const snapshot = JSON.parse(frozen.snapshot_json);
    assert.equal(frozen.context, job.context); assert.equal(frozen.prompt.length, 20000);
    assert.equal(snapshot.globalContext, ''); assert.equal(snapshot.moduleContext, '');
    assert.deepEqual(snapshot.fixedReferenceImages, []); assert.deepEqual(snapshot.skills, []);
    assert.deepEqual(JSON.parse(frozen.reference_ids), ids);
    assert.deepEqual(snapshot.authorizedReferenceOwners, Object.fromEntries(ids.map(assetId => [assetId, user.id])));
    await assert.rejects(() => tasks.submitStudioBatch(user.id, { ...body, requestId: randomUUID(), prompt: 'x'.repeat(20001) }, undefined, { quoteOnly: true, save: async () => {} }));
    let ordinary;
    await tasks.submitStudioBatch(user.id, { ...body, requestId: randomUUID(), prompt: 'ORDINARY', referenceIds: [ids[0]], draft: undefined }, undefined, { quoteOnly: true, save: async (_tx, value) => { ordinary = value; } });
    assert.equal(JSON.parse(ordinary.snapshot_json).globalContext, 'ORDINARY_GLOBAL');
    assert.ok(ordinary.context.includes('ORDINARY_GLOBAL'));
    assert.equal(await prisma.imageStudioTask.count(), 0);
    assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: user.id } })).balance, 100);
  });
  await check('legacy image capture retains selected quality route without changing ordinary snapshots', async () => {
    const integration = await import('../src/lib/integrations/image-generation.ts');
    const defaults = await import('../src/lib/integrations/image-generation-defaults.ts');
    const settings = await import('../src/lib/image-studio/settings.ts');
    const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: settings.IMAGE_STUDIO_SETTING_KEY } });
    const config = JSON.parse(row.value_json); config.prices['gpt-image-2.5-sunburst'] = 5;
    await prisma.platformSetting.update({ where: { key: row.key }, data: { value_json: JSON.stringify(config) } });
    await prisma.platformSetting.create({ data: { key: 'image_generation_model_defaults_v1', value_json: JSON.stringify({ version: 2, revision: 3, models: {}, qualityRoutes: { 'gpt-image-2.5-sunburst': { max: 'shared' } } }) } });
    const expected = (await defaults.resolveImageGenerationRequestRoute('gpt-image-2.5-sunburst', 'max', 'shared')).qualityRoute;
    assert.deepEqual((await integration.captureImageGenerationRequestChannel('gpt-image-2.5-sunburst', 'max', 'shared')).qualityRoute, expected);
    assert.deepEqual((await integration.captureImageGenerationChannel('gpt-image-2.5-sunburst', 'original', prisma, expected)).qualityRoute, expected);
    assert.ok(!('qualityRoute' in await integration.captureImageGenerationRequestChannel('gpt-image-2', 'medium', 'shared')));
    assert.equal(await prisma.imageStudioTask.count(), 0);
  });
  await check('UI task query preserves public uncertainty and worker failure detail without resubmission', async () => {
    const requestId = randomUUID(), batchId = createHash('sha256').update(`${user.id}:${requestId}`).digest('hex');
    await store.saveUiDocument(user.id, 'request', requestId, 0, { id: requestId, state: 'accepted', body: { requestId } });
    const task = await prisma.imageStudioTask.create({ data: { id: `${batchId}-0`, batch_id: batchId, owner_id: user.id, ordinal: 0,
      fingerprint: 'ui-query-fixture', prompt: 'fixture', context: '', revision: 1, model: 'gpt-image-2', reference_ids: '[]',
      unit_credits: 5, status: 'sr_uncertain', error: 'Original fee awaits reconciliation' } });
    const uncertain = await generation.uiJobStatus(user, requestId);
    assert.equal(uncertain.tasks[0].status, 'uncertain'); assert.equal(uncertain.tasks[0].error, task.error);
    await prisma.imageStudioTask.update({ where: { id: task.id }, data: { status: 'failed', error: 'Output validation failed' } });
    const failed = await generation.uiJobStatus(user, requestId);
    assert.equal(failed.tasks[0].status, 'failed'); assert.equal(failed.tasks[0].error, 'Output validation failed');
    assert.equal(await prisma.imageStudioTask.count(), 1);
    assert.equal(await prisma.creditLedger.count(), 0); assert.equal(await prisma.costLedger.count(), 0);
  });
  const pdfEvidence = JSON.parse(await fs.readFile(path.join(root, '.private/ui-design/pdf-evidence.json'), 'utf8'));
  assert.deepEqual(pdfEvidence.dependencyHashes, Object.fromEntries(Object.entries(manifest.files).filter(([name]) => name.startsWith('node_modules/'))));
  assert.equal(pdfEvidence.parserSha256, manifest.files['requirements-source.cjs']);
  assert.equal(pdfEvidence.exitCode, 0);
  checks.push('reused unchanged real PDF text-extraction evidence');
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ packageDigest: manifest.digest, checks, database: 'isolated local SQLite', paidCalls: 0, browserAcceptance: false }, null, 2));
  console.log('Evidence', evidence);
} finally { await prisma.$disconnect(); moduleApi._resolveFilename = resolveModule; }
