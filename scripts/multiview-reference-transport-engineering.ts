import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
import { seedanceLocalReferenceTransport } from '../src/lib/provider/reference-image-transport';
import { buildSeedanceVideoPayload, redactInlineImageTransport } from '../src/lib/provider/jimeng';
import type { CreateVideoInput } from '../src/types';

async function main() {
  const root = process.cwd();
  const source = readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
  const ast = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  const branches: ts.IfStatement[] = [];
  const calls: ts.CallExpression[] = [], declarations: ts.VariableDeclaration[] = [], assignments: ts.BinaryExpression[] = [];
  const identifier = (node: ts.Node | undefined, name: string): node is ts.Identifier => Boolean(node && ts.isIdentifier(node) && node.text === name);
  const property = (object: ts.ObjectLiteralExpression, name: string) => {
    const matches = object.properties.filter((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item)
      && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
    assert.equal(matches.length, 1, `Expected one ${name} property`);
    return matches[0].initializer;
  };
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(ast).startsWith("requestedProvider === 'seedance'")
      && node.thenStatement.getText(ast).includes('await seedanceLocalReferenceTransport(')) branches.push(node);
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignments.push(node);
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
  const createCalls = calls.filter(call => identifier(call.expression, 'createVideoTask'));
  assert.equal(createCalls.length, 1);
  const createCall = createCalls[0];
  assert.equal(createCall.arguments.length, 3, 'Keep provider input, diagnostics and private recipe options');
  const createInput = createCall.arguments[0], createOptions = createCall.arguments[2];
  assert.ok(ts.isObjectLiteralExpression(createInput));
  assert.equal(createInput.properties.length, 2);
  for (const [index, name] of Array.from(['providerInput', 'seedanceReferenceTransport'].entries())) {
    const spread = createInput.properties[index];
    assert.ok(ts.isSpreadAssignment(spread) && identifier(spread.expression, name));
  }
  assert.ok(ts.isArrowFunction(createCall.arguments[1]), 'Preserve the diagnostic callback');
  assert.ok(ts.isObjectLiteralExpression(createOptions));
  const sensitiveRecipe = property(createOptions, 'sensitiveRecipe');
  assert.ok(ts.isCallExpression(sensitiveRecipe) && identifier(sensitiveRecipe.expression, 'Boolean')
    && sensitiveRecipe.arguments.length === 1,
  'Private provider logging must follow the validated multiview state, not a browser field');
  for (const variant of ['ordinary', 'rotation', 'groups', 'action']) {
    const options = runInNewContext(`(${createOptions.getText(ast)})`, {
      groupRefs: variant === 'groups' ? [{}] : [], multiviewGeneration: variant === 'rotation' ? {} : null,
      multiviewAction: variant === 'action' ? { action: { origins: ['synthetic-action'] } } : null,
      videoGroups: { origins: ['synthetic-group'] },
    });
    assert.equal(options.sensitiveRecipe, variant !== 'ordinary');
    assert.deepEqual(Object.keys(options).sort(), ['sensitiveRecipe', ...(['groups', 'action'].includes(variant) ? ['privateOrigins'] : [])].sort());
    if (variant === 'groups' || variant === 'action') assert.deepEqual(Array.from(options.privateOrigins), [`synthetic-${variant === 'groups' ? 'group' : 'action'}`]);
  }

  const transportCalls = calls.filter(call => identifier(call.expression, 'seedanceLocalReferenceTransport'));
  assert.equal(transportCalls.length, 1);
  const transportCall = transportCalls[0];
  assert.ok(transportCall.pos > branch.pos && transportCall.end < branch.end);
  assert.equal(transportCall.arguments.length, 4);
  const authorizedReferences = transportCall.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(authorizedReferences));
  const personalReference = {}, actionReference = {};
  for (const actionImageForTransport of [null, actionReference]) {
    const references = runInNewContext(`(${authorizedReferences.getText(ast)})`, {
      generationReferenceImages: [personalReference], actionImageForTransport,
    });
    assert.deepEqual(Array.from(references), actionImageForTransport ? [personalReference, actionReference] : [personalReference]);
  }
  assert.ok(identifier(transportCall.arguments[2], 'undefined'));
  const privateReferences = transportCall.arguments[3];
  assert.ok(ts.isConditionalExpression(privateReferences) && identifier(privateReferences.condition, 'multiviewSystemReference'));
  assert.ok(ts.isArrayLiteralExpression(privateReferences.whenTrue) && privateReferences.whenTrue.elements.length === 1);
  assert.ok(ts.isArrayLiteralExpression(privateReferences.whenFalse) && privateReferences.whenFalse.elements.length === 0);
  const privateReference = privateReferences.whenTrue.elements[0];
  assert.ok(ts.isObjectLiteralExpression(privateReference) && privateReference.properties.length === 2);
  for (const field of ['mimeType', 'bytes']) {
    const value = property(privateReference, field);
    assert.ok(ts.isPropertyAccessExpression(value) && identifier(value.expression, 'multiviewSystemReference') && value.name.text === field);
  }
  const referenceWrites = assignments.filter(node => identifier(node.left, 'generationReferenceImages'));
  assert.equal(referenceWrites.length, 1);
  const referenceSource = referenceWrites[0].right;
  assert.ok(ts.isConditionalExpression(referenceSource) && ts.isAwaitExpression(referenceSource.whenTrue));
  const authorizedCall = referenceSource.whenTrue.expression;
  assert.ok(ts.isCallExpression(authorizedCall) && identifier(authorizedCall.expression, 'getAuthorizedReferenceImagesForUse')
    && authorizedCall.arguments.length === 2 && identifier(authorizedCall.arguments[0], 'user')
    && identifier(authorizedCall.arguments[1], 'generationReferenceImageIds'));
  assert.ok(ts.isArrayLiteralExpression(referenceSource.whenFalse) && referenceSource.whenFalse.elements.length === 0);
  const referenceMutations = calls.filter(call => ts.isPropertyAccessExpression(call.expression)
    && identifier(call.expression.expression, 'generationReferenceImages') && call.expression.name.text !== 'map');
  assert.equal(referenceMutations.length, 0, 'Private references must not be appended to the authorized personal references');
  const snapshotCalls = calls.filter(call => identifier(call.expression, 'createTaskSnapshot'));
  assert.equal(snapshotCalls.length, 1);
  const snapshotInput = snapshotCalls[0].arguments[0];
  assert.ok(ts.isObjectLiteralExpression(snapshotInput) && identifier(property(snapshotInput, 'input'), 'providerInput'),
    'Transient private inline bytes must not be persisted as the input snapshot');
  const providerInputs = declarations.filter(node => identifier(node.name, 'providerInput'));
  assert.equal(providerInputs.length, 1);
  assert.ok(providerInputs[0].initializer && ts.isObjectLiteralExpression(providerInputs[0].initializer));
  assert.ok(identifier(property(providerInputs[0].initializer, 'reference_image_urls'), 'referenceImageUrls'));
  assert.ok(!providerInputs[0].initializer.getText(ast).includes('multiviewSystemReference'));
  const taskParams = declarations.filter(node => identifier(node.name, 'taskParams'));
  assert.equal(taskParams.length, 1);
  assert.ok(taskParams[0].initializer && ts.isObjectLiteralExpression(taskParams[0].initializer));
  assert.ok(identifier(property(taskParams[0].initializer, 'referenceImageIds'), 'generationReferenceImageIds'));
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
  const guideBytes = await sharp({ create: { width: 2, height: 2, channels: 4,
    background: { r: 64, g: 32, b: 16, alpha: 1 } } }).png().toBuffer();
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const guide = { assetId: 'synthetic-private-guide', referenceImageId: 'synthetic-private-guide-reference',
    sourceUrl: 'https://sd2.youdooart.com/uploads/assets/private-guide-not-a-public-file.png',
    mimeType: 'image/png' as const, bytes: guideBytes, sha256: hash(guideBytes) };
  assert.notEqual(guide.sha256, hash(bytes));
  const local = '/uploads/assets/original.png', url = `https://sd2.youdooart.com${local}`;
  const file = path.join(folder, 'public', local);
  writeFileSync(file, bytes, { flag: 'wx' });
  const asset = { original_url: url, type: 'image', status: 'active', mime_type: 'image/png', file_size: bytes.length };
  const input: CreateVideoInput = { generation_mode: 'all_in_one_reference', prompt: 'synthetic rotation', reference_image_urls: [url], model: 'dreamina-seedance-2-5-260628' };
  const before = structuredClone(input);
  let transportCount = 0, networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Network prohibited in original-transport fixture'); };
  const context: Record<string, any> = {
    requestedProvider: 'seedance', multiviewGeneration: { presetId: 'multiview-360' }, body: {},
    multiviewSystemReference: null, multiviewAction: null, actionImageForTransport: null,
    cleanSourceMetadata: (value: unknown) => value || {}, requestSource: { source_metadata: {} },
    providerInput: input, requestCallbackUrl: undefined, generationReferenceImages: [{ url, asset }],
    seedanceLocalReferenceTransport: async (...args: Parameters<typeof seedanceLocalReferenceTransport>) => {
      transportCount++;
      assert.deepEqual(Array.from(args[1]), context.actionImageForTransport
        ? [...context.generationReferenceImages, context.actionImageForTransport] : context.generationReferenceImages);
      assert.equal(args[2], undefined);
      assert.equal(args[3]?.length, context.multiviewSystemReference ? 1 : 0);
      if (context.multiviewSystemReference) {
        assert.equal(args[3]![0].mimeType, 'image/png'); assert.equal(args[3]![0].bytes, guideBytes);
      }
      return seedanceLocalReferenceTransport(...args);
    },
    errorJson: (error: string, status: number) => ({ error, status }),
  };
  runInNewContext(code, context);
  const checks: string[] = [];
  checks.push('actual_ast_provider_input_transport_spread_diagnostic_and_validated_multiview_sensitive_flag');
  checks.push('private_bytes_separate_from_authorized_personal_references_and_durable_input_snapshot');
  process.chdir(folder);
  try {
    for (const model of ['dreamina-seedance-2-0-260128', 'dreamina-seedance-2-5-260628']) {
      context.providerInput = { ...input, model };
      const patch = await context.prepare();
      assert.equal(patch.status, undefined, `Preparation must succeed, not hide a VM error: ${patch.error || ''}`);
      const payload = buildSeedanceVideoPayload({ ...context.providerInput, ...patch });
      assert.equal(payload.model, model);
      assert.ok(Array.isArray(payload.content));
      const image = payload.content.find((item: { type: string }) => item.type === 'image_url');
      assert.equal(image?.image_url?.url, `data:image/png;base64,${bytes.toString('base64')}`);
      assert.ok(!JSON.stringify(redactInlineImageTransport({ payload })).includes(bytes.toString('base64')));
    }
    assert.deepEqual(input, before); assert.deepEqual(readFileSync(file), bytes);
    checks.push('actual_multiview_branch_both_models_exact_original_bytes_no_url_fetch_or_snapshot_mutation');
    const authorizedBefore = structuredClone(context.generationReferenceImages), guideBefore = Buffer.from(guideBytes);
    context.multiviewSystemReference = guide;
    assert.equal(existsSync(path.join(folder, 'public/uploads/assets/private-guide-not-a-public-file.png')), false);
    for (const model of ['dreamina-seedance-2-0-260128', 'dreamina-seedance-2-5-260628']) {
      context.providerInput = { ...input, model };
      const providerBefore = structuredClone(context.providerInput);
      const patch = await context.prepare();
      assert.equal(patch.status, undefined, `Private preparation must succeed: ${patch.error || ''}`);
      assert.deepEqual(Array.from(patch.reference_image_base64_data), [
        `data:image/png;base64,${bytes.toString('base64')}`, `data:image/png;base64,${guideBytes.toString('base64')}`,
      ]);
      const payload = buildSeedanceVideoPayload({ ...context.providerInput, ...patch });
      assert.equal(payload.model, model); assert.ok(Array.isArray(payload.content));
      const images = payload.content.filter((item: { type: string }) => item.type === 'image_url');
      assert.equal(images.length, 2);
      for (const [index, expected] of Array.from([bytes, guideBytes].entries())) {
        const dataUrl = images[index].image_url.url;
        assert.equal(dataUrl, `data:image/png;base64,${expected.toString('base64')}`);
        assert.equal(hash(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')), hash(expected));
      }
      assert.ok(!JSON.stringify(payload).includes(guide.sourceUrl));
      for (const value of [bytes, guideBytes]) assert.ok(!JSON.stringify(redactInlineImageTransport({ payload })).includes(value.toString('base64')));
      assert.deepEqual(context.providerInput, providerBefore);
      assert.deepEqual(context.generationReferenceImages, authorizedBefore);
      assert.deepEqual(context.providerInput.reference_image_urls, [url]);
      assert.ok(!JSON.stringify(context.providerInput).includes(guide.assetId));
      assert.ok(!JSON.stringify(context.providerInput).includes(guide.sourceUrl));
      assert.ok(!JSON.stringify(context.providerInput).includes(guideBytes.toString('base64')));
      assert.deepEqual(guideBytes, guideBefore); assert.equal(hash(guideBytes), guide.sha256);
    }
    assert.equal(networkCalls, 0); assert.deepEqual(input, before); assert.deepEqual(readFileSync(file), bytes);
    checks.push('both_models_personal_image1_then_private_image2_exact_hashes_without_public_guide_file_url_or_network_read');
    context.multiviewSystemReference = null;
    context.multiviewGeneration = null;
    context.body = { multiview_generation: { presetId: 'forged' }, client_name: 'multiview',
      multiviewSystemReference: guide, source_metadata: { protected_module: 'forged' } };
    const called = transportCount;
    assert.equal(Object.keys(await context.prepare()).length, 0); assert.equal(transportCount, called);
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
    assert.equal(networkCalls, 0);
  } finally { process.chdir(root); }
  console.log(JSON.stringify({ completed: true, checks, productionWrites: 0, generationCalls: 0, billingChanges: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
