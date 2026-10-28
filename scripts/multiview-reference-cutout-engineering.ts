import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
import { normalizeCutoutSettings } from '../src/lib/cutout/settings';
import { createMultiviewReferenceRecipe } from '../src/lib/video/multiview-reference-layout';

/** Exercise the actual adapter with isolated in-memory receipts and a fake upstream; never creates a real model job. */
async function main() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sd2-reference-cutout-')));
  const require = createRequire(import.meta.url), entries = new Map<string, { value_json: string }>();
  const info = { taskId: 'source-1', sourceVersion: 'a'.repeat(64), width: 80, height: 120, duration: 5, timestamps: Array.from({ length: 10 }, (_, index) => index / 2) };
  const slots = [0, 1].map(frame => ({ id: `slot-${frame}`, frame, manual: false, name: '' }));
  const recipe = createMultiviewReferenceRecipe(info, slots, { width: 1920, height: 1080, background: '#d6dbdf' });
  const work = { id: 'work-1', removed: false, sourceState: 'current', sourceTaskId: info.taskId, sourceVersion: info.sourceVersion, sourceId: null, projectId: null, recipe, info };
  const owner = { id: 'owner-1', role: 'admin' }, other = { id: 'other-1', role: 'user' };
  const sourceBytes = await sharp({ create: { width: 80, height: 120, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } }).png().toBuffer();
  const foregroundBytes = await sharp({ create: { width: 80, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 40, height: 80, channels: 4, background: '#ffcc00' } }).png().toBuffer(), left: 20, top: 20 }]).png().toBuffer();
  let uploads = 0, jobs = 0, usage = 0, failed = false, succeeded = false;
  const job = (id: string) => ({ job_id: id, kind: 'cutout', status: succeeded ? 'succeeded' : 'running', created_at: 1, updated_at: 2,
    ...(succeeded ? { result: { result_url: `/api/cutout/v1/results/${id}/foreground.png` } } : {}) });
  const db: any = { platformSetting: {
    findUnique: async ({ where }: any) => entries.get(where.key) || null,
    upsert: async ({ where, create }: any) => { if (!entries.has(where.key)) entries.set(where.key, { value_json: create.value_json }); return entries.get(where.key); },
    updateMany: async ({ where, data }: any) => { const prior = entries.get(where.key); if (!prior || prior.value_json !== where.value_json) return { count: 0 }; prior.value_json = data.value_json; return { count: 1 }; },
  }, $queryRaw: async () => [], $transaction: async (action: any) => action(db) };
  class WorkError extends Error { constructor(message: string, public status = 400) { super(message); } }
  const source = await readFile(path.join(process.cwd(), 'src/lib/video/multiview-reference-cutout.server.ts'), 'utf8');
  const transpiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} as any };
  const imported: Record<string, unknown> = {
    'server-only': {}, '@/lib/prisma': { prisma: db },
    '@/lib/cutout/proxy': { cutoutBusinessCredential: (_env: unknown, id: string) => id === owner.id ? 'isolated-authorized-binding' : null,
      proxyCutout: async (request: Request, parts: string[], actor: any) => {
        assert.equal(actor.id, owner.id, 'another actor reached upstream');
        if (parts[1] === 'capabilities') return Response.json({ integration: { ready: true }, models: [] });
        if (parts[1] === 'assets') { uploads++; return Response.json({ asset_id: `asset-${uploads}`, width: 80, height: 120, size: sourceBytes.length }); }
        if (parts[1] === 'jobs' && request.method === 'POST') { jobs++; return failed ? Response.json({ submission_made: null }, { status: 502 }) : Response.json(job(`job-${jobs}`)); }
        if (parts[1] === 'jobs') return Response.json(job(parts[2]));
        if (parts[1] === 'results') return new Response(foregroundBytes, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(foregroundBytes.length) } });
        throw new Error('unexpected fake upstream path');
      } },
    '@/lib/cutout/receipt': require('../src/lib/cutout/receipt'), '@/lib/cutout/result-content': require('../src/lib/cutout/result-content'),
    '@/lib/cutout/settings': { normalizeCutoutSettings }, '@/lib/admin/usage-attribution': { recordUsageAttribution: async () => { usage++; } },
    './multiview-works': { currentMultiviewActor: async () => owner, getMultiviewWork: async (actor: any) => { if (actor.id !== owner.id) throw new WorkError('forbidden', 403); return work; }, MultiviewWorkError: WorkError },
    './multiview': { multiviewFrame: async () => sourceBytes },
    './multiview-action-capability': { MULTIVIEW_ACTION_ENABLED: true },
  };
  const context = vm.createContext({ module, exports: module.exports, require: (name: string) => Object.hasOwn(imported, name) ? imported[name] : require(name),
    Buffer, Request, Response, FormData, Blob, URL, Uint8Array, console,
    process: { env: { NODE_ENV: 'test' }, cwd: () => directory, getuid: process.getuid?.bind(process) }, fetch: () => { throw new Error('External network prohibited'); } });
  try {
    new vm.Script(transpiled, { filename: 'multiview-reference-cutout.server.cjs' }).runInContext(context);
    const adapter = module.exports, request = new Request('https://isolated.invalid/multiview');
    await assert.rejects(adapter.mutateMultiviewReferenceCutout(request, other, work.id, slots[0].id, { action: 'prepare' }));
    assert.equal(uploads + jobs, 0, 'unauthorized attempt reached source upload or model');
    const prepared = await adapter.mutateMultiviewReferenceCutout(request, owner, work.id, slots[0].id, { action: 'prepare' });
    assert.equal(prepared.stage, 'awaiting-confirmation'); assert.equal(uploads, 1); assert.equal(jobs, 0, 'prepare silently billed a model');
    await adapter.mutateMultiviewReferenceCutout(request, owner, work.id, slots[0].id, { action: 'prepare' });
    assert.equal(uploads, 1, 'same source uploaded again');
    const input = { action: 'start', settings: normalizeCutoutSettings({}), confirmUnknownPrice: true };
    await assert.rejects(adapter.mutateMultiviewReferenceCutout(request, owner, work.id, slots[0].id, { ...input, confirmUnknownPrice: false }));
    assert.equal(jobs, 0, 'unknown fees were accepted without confirmation');
    await Promise.all([adapter.mutateMultiviewReferenceCutout(request, owner, work.id, slots[0].id, input), adapter.mutateMultiviewReferenceCutout(request, owner, work.id, slots[0].id, input)]);
    assert.equal(jobs, 1, 'concurrent confirmations created multiple model requests'); assert.equal(usage, 1, 'one request wrote multiple usage records');
    succeeded = true;
    const ready = await adapter.getMultiviewReferenceCutout(request, owner, work.id, slots[0].id);
    assert.equal(ready.stage, 'ready'); assert.ok(ready.foreground?.sha256);
    const bytes = await adapter.readMultiviewReferenceForeground(owner, info.taskId, info, slots[0], ready.foreground);
    assert.equal(Buffer.compare(bytes, foregroundBytes), 0, 'derived foreground changed bytes');
    await assert.rejects(adapter.readMultiviewReferenceForeground(owner, info.taskId, info, slots[1], ready.foreground));
    await assert.rejects(adapter.readMultiviewReferenceForeground(owner, info.taskId, { ...info, sourceVersion: 'b'.repeat(64) }, slots[0], ready.foreground));
    (imported['./multiview-action-capability'] as { MULTIVIEW_ACTION_ENABLED: boolean }).MULTIVIEW_ACTION_ENABLED = false;
    const beforeGuard = { uploads, jobs };
    await assert.rejects(adapter.mutateMultiviewReferenceCutout(request, owner, work.id, slots[1].id, { action: 'prepare' }));
    assert.equal((await adapter.getMultiviewReferenceCutout(request, owner, work.id, slots[0].id)).stage, 'ready', 'guard blocked the accepted result');
    assert.deepEqual({ uploads, jobs }, beforeGuard, 'guard accepted a new upload or model job');
    (imported['./multiview-action-capability'] as { MULTIVIEW_ACTION_ENABLED: boolean }).MULTIVIEW_ACTION_ENABLED = true;
    succeeded = false; failed = true;
    await adapter.mutateMultiviewReferenceCutout(request, owner, work.id, slots[1].id, { action: 'prepare' });
    const unknown = await adapter.mutateMultiviewReferenceCutout(request, owner, work.id, slots[1].id, input);
    assert.equal(unknown.stage, 'unknown'); const sent = jobs;
    await adapter.mutateMultiviewReferenceCutout(request, owner, work.id, slots[1].id, input);
    await adapter.getMultiviewReferenceCutout(request, owner, work.id, slots[1].id);
    assert.equal(jobs, sent, 'unknown request was automatically resent');
    console.log('reference cutout adapter: source/actor isolation, explicit fees, CAS single submit, transparent byte binding, unknown no-resend passed');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
