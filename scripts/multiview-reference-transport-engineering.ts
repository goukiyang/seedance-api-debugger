import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { seedanceLocalReferenceTransport } from '../src/lib/provider/reference-image-transport';
import { buildSeedanceVideoPayload, redactInlineImageTransport } from '../src/lib/provider/jimeng';
import type { CreateVideoInput } from '../src/types';

async function main() {
  const root = process.cwd();
  const source = readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
  const ast = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  const branches: ts.IfStatement[] = [];
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(ast).startsWith("requestedProvider === 'seedance'")
      && node.thenStatement.getText(ast).includes('await seedanceLocalReferenceTransport(')) branches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(branches.length, 1);
  const branch = branches[0];
  const authorization = source.indexOf('await getAuthorizedReferenceImagesForUse(user, generationReferenceImageIds)');
  assert.ok(authorization > 0 && authorization < branch.pos);
  assert.ok(branch.end < source.indexOf('const task = await tx.videoTask.create('), 'prepare before accepting/freezing a new task');
  const ledger = source.slice(source.indexOf('const providerRequest = await createProviderApiRequest('), source.indexOf('providerRequestId = providerRequest.id;'));
  assert.ok(ledger.length > 0 && !ledger.includes('seedanceReferenceTransport'), 'durable identity must remain URL-based');
  assert.ok(source.includes('createVideoTask({ ...providerInput, ...seedanceReferenceTransport }'));
  const code = ts.transpileModule(`async function prepare() {
    let seedanceReferenceTransport = {};
    ${branch.getText(ast)}
    return seedanceReferenceTransport;
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true });
  const folder = mkdtempSync(path.join(scratch, 'multiview-original-'));
  mkdirSync(path.join(folder, 'public/uploads/assets'), { recursive: true });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const local = '/uploads/assets/original.png', url = `https://sd2.youdooart.com${local}`;
  const file = path.join(folder, 'public', local);
  writeFileSync(file, bytes, { flag: 'wx' });
  const asset = { original_url: url, type: 'image', status: 'active', mime_type: 'image/png', file_size: bytes.length };
  const input: CreateVideoInput = { generation_mode: 'all_in_one_reference', prompt: 'synthetic rotation', reference_image_urls: [url], model: 'dreamina-seedance-2-5-260628' };
  const before = structuredClone(input);
  let calls = 0;
  globalThis.fetch = async () => { throw new Error('Network prohibited in original-transport fixture'); };
  const context: Record<string, any> = {
    requestedProvider: 'seedance', multiviewGeneration: { presetId: 'multiview-360' }, body: {},
    cleanSourceMetadata: (value: unknown) => value || {}, requestSource: { source_metadata: {} },
    providerInput: input, requestCallbackUrl: undefined, generationReferenceImages: [{ url, asset }],
    seedanceLocalReferenceTransport: async (...args: Parameters<typeof seedanceLocalReferenceTransport>) => { calls++; return seedanceLocalReferenceTransport(...args); },
    errorJson: (error: string, status: number) => ({ error, status }),
  };
  runInNewContext(code, context);
  const checks: string[] = [];
  process.chdir(folder);
  try {
    for (const model of ['dreamina-seedance-2-0-260128', 'dreamina-seedance-2-5-260628']) {
      context.providerInput = { ...input, model };
      const patch = await context.prepare();
      const payload = buildSeedanceVideoPayload({ ...context.providerInput, ...patch });
      assert.equal(payload.model, model);
      assert.ok(Array.isArray(payload.content));
      const image = payload.content.find((item: { type: string }) => item.type === 'image_url');
      assert.equal(image?.image_url?.url, `data:image/png;base64,${bytes.toString('base64')}`);
      assert.ok(!JSON.stringify(redactInlineImageTransport({ payload })).includes(bytes.toString('base64')));
    }
    assert.deepEqual(input, before); assert.deepEqual(readFileSync(file), bytes);
    checks.push('actual_multiview_branch_both_models_exact_original_bytes_no_url_fetch_or_snapshot_mutation');
    context.multiviewGeneration = null;
    context.body = { multiview_generation: { presetId: 'forged' }, client_name: 'multiview' };
    const called = calls;
    assert.equal(Object.keys(await context.prepare()).length, 0); assert.equal(calls, called);
    context.body = { canvas_document_id: 'existing-canvas' };
    assert.ok((await context.prepare()).reference_image_base64_data);
    context.requestedProvider = 'h3';
    assert.equal(Object.keys(await context.prepare()).length, 0);
    checks.push('validated_multiview_only_existing_canvas_and_other_provider_scope_preserved');
    context.requestedProvider = 'seedance'; context.body = {}; context.multiviewGeneration = { presetId: 'multiview-360' };
    context.generationReferenceImages = [];
    assert.equal(Object.keys(await context.prepare()).length, 0, 'no unauthorized filesystem source');
    context.generationReferenceImages = [{ url, asset: { ...asset, status: 'deleted' } }];
    assert.equal(Object.keys(await context.prepare()).length, 0);
    context.generationReferenceImages = [{ url, asset: { ...asset, file_size: bytes.length + 1 } }];
    assert.equal((await context.prepare()).status, 400, 'changed source must reject before provider/freeze');
    context.generationReferenceImages = [{ url, asset: { ...asset, file_size: 30_000_000 } }];
    assert.equal((await context.prepare()).status, 400);
    const outside = path.join(folder, 'outside.png'); writeFileSync(outside, bytes, { flag: 'wx' });
    symlinkSync(outside, path.join(folder, 'public/uploads/assets/escape.png'));
    const escape = 'https://sd2.youdooart.com/uploads/assets/escape.png';
    context.providerInput = { ...input, reference_image_urls: [escape] };
    context.generationReferenceImages = [{ url: escape, asset: { ...asset, original_url: escape } }];
    assert.equal((await context.prepare()).status, 400);
    checks.push('authorized_record_required_deleted_changed_oversize_and_path_escape_guarded');
  } finally { process.chdir(root); }
  console.log(JSON.stringify({ completed: true, checks, productionWrites: 0, generationCalls: 0, billingChanges: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
