import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import sharp from 'sharp';
import ts from 'typescript';
import type { HdJob } from '../src/lib/media/hd-derivatives';
import type { ModuleCoverRecipe, ModuleCoverSourceDTO } from '../src/lib/image-studio/module-cover-types';

// Real temporary files and Sharp; actual candidate declarations. Only the
// authorized asset directory, hidden list and optional lookup boundary are controlled.
// No Prisma module, application environment, HTTP, production data or HD queue loads.
type Values = Record<string, unknown>;
type FixtureAsset = { id: string; owner_id: string; original_url: string; hash: string; file_size: number;
  width: number; height: number; mime_type: string; type: string; status: string };
type Actor = { id: string; role: string; account_type: string };
type Target = { target: { kind: 'module'; id: string }; ownerId: string; canManage: boolean; shared: boolean };
type Client = { asset: { findMany(input: { where: { id: { in: string[] }; owner_id: string; type: string; status: string } }): Promise<FixtureAsset[]> } };
type CoverFunctions = {
  inspectSources(actor: Actor, state: Target, ids: string[], client: Client): Promise<ModuleCoverSourceDTO[]>;
  sourceVersion(asset: FixtureAsset): Promise<string>;
  renderCover(actor: Actor, state: Target, recipe: ModuleCoverRecipe): Promise<{ image: Buffer; thumbnail: Buffer }>;
};
type HdFunctions = {
  hdSource(source: string): Promise<{ file: string; version: string; size: number } | null>;
  hdRepresentationVersion(source: string, job: HdJob): Promise<string | undefined>;
  HD_POLICY: string;
};
const sourceFiles = ['scripts/module-cover-hd-preview-fixture.ts', 'src/lib/image-studio/module-cover.ts',
  'src/lib/image-studio/module-cover-types.ts', 'src/lib/image-studio/media.ts', 'src/lib/image-studio/limits.ts',
  'src/lib/assets/site-url.ts', 'src/lib/media/hd-derivatives.ts', 'src/lib/media/image-comparison-version.ts',
  'src/lib/media/hd-encoder.ts', 'src/lib/media/hd-storage-root.ts'];
const baselineCommit = '4b88f1c3bc836b81a5dd445103fd61635f91f255';
// Captured from the unmodified renderCover declaration at the baseline commit.
const baselineRenderSHA256 = '059451227fc497f1facac647fddb2f536a7c05620183551cbf6c861ccc88288c';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function main() {
  const root = await fs.realpath(process.cwd());
  const source = (file: string) => fs.readFile(path.join(root, file), 'utf8');
  const sourceSHA256 = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await source(file))])));
  function declarations(file: string, text: string, names: string[]) {
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const selected = ast.statements.filter(statement => (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && statement.name && names.includes(statement.name.text)
      || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && names.includes(item.name.text)));
    assert.equal(selected.length, names.length, `Required real declarations: ${file}`);
    return selected.map(statement => statement.getText(ast)).join('\n');
  }
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'sd2-cover-hd-preview-'));
  const uploadDirectory = path.join(directory, 'public/uploads'), hdDirectory = path.join(directory, 'storage/hd-derivatives');
  let forbiddenCalls = 0, lookups = 0;
  const forbidden = (): never => { forbiddenCalls++; throw new Error('Unapproved fixture boundary'); };
  const checks: string[] = [];
  let imageSHA256 = '', thumbnailSHA256 = '';
  try {
    await fs.mkdir(uploadDirectory, { recursive: true }); await fs.mkdir(hdDirectory, { recursive: true });
    const common = { Buffer, URL, URLSearchParams, AbortSignal, Error, fs, path, createHash, sharp,
      process: { cwd: () => directory, env: { NODE_ENV: 'test' } }, fetch: forbidden, require: forbidden, requestHd: forbidden };
    const evaluate = (text: string, globals: Values = {}): Values => {
      const exports: Values = {};
      const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS } }).outputText;
      vm.runInNewContext(compiled, { ...common, ...globals, exports }, { timeout: 1000 });
      return exports;
    };
    const site = evaluate(await source('src/lib/assets/site-url.ts'));
    const coverTypes = evaluate(await source('src/lib/image-studio/module-cover-types.ts'));
    const limits = evaluate(await source('src/lib/image-studio/limits.ts'));
    const storage = evaluate(declarations('hd-storage-root.ts', await source('src/lib/media/hd-storage-root.ts'), ['HD_UPLOAD_DIRECTORY_ACCESS']), { constants });
    const encoder = evaluate(declarations('hd-encoder.ts', await source('src/lib/media/hd-encoder.ts'), ['HD_LEGACY_ENCODER_STRATEGY', 'hdEncoderStrategy']));
    const hd = evaluate(declarations('hd-derivatives.ts', await source('src/lib/media/hd-derivatives.ts'),
      ['HD_POLICY', 'hdSource', 'hdRepresentationVersion']), { ...site, ...storage, ...encoder, hdDirectory: () => hdDirectory }) as unknown as HdFunctions;
    const comparison = evaluate(declarations('image-comparison-version.ts', await source('src/lib/media/image-comparison-version.ts'),
      ['comparisonOriginalVersion']), { hdSource: hd.hdSource }) as unknown as { comparisonOriginalVersion(source: string): Promise<string | null> };
    const media = evaluate(declarations('media.ts', await source('src/lib/image-studio/media.ts'),
      ['studioTemplateAssetUrl', 'readStudioImage']), { ...site, ...limits }) as unknown as {
        studioTemplateAssetUrl(id: string): string; readStudioImage(url: string, signal?: AbortSignal): Promise<Buffer>;
      };
    const pixels = Buffer.alloc(120 * 80 * 3);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 37 + Math.floor(index / 97) * 13) & 255;
    const original = await sharp(pixels, { raw: { width: 120, height: 80, channels: 3 } })
      .withMetadata({ orientation: 6 }).png({ compressionLevel: 0 }).toBuffer();
    const originalFile = path.join(uploadDirectory, 'original.png'); await fs.writeFile(originalFile, original);
    const originalMetadata = await sharp(original).metadata(); assert.equal(originalMetadata.orientation, 6);
    const asset: FixtureAsset = { id: 'fixture-original', owner_id: 'fixture-owner', type: 'image', status: 'active',
      original_url: '/uploads/original.png', hash: sha(original), file_size: original.length, width: 120, height: 80, mime_type: 'image/png' };
    const actor: Actor = { id: asset.owner_id, role: 'user', account_type: 'internal' };
    const state: Target = { target: { kind: 'module', id: 'fixture-module' }, ownerId: actor.id, canManage: true, shared: false };
    let hidden = false;
    const client: Client = { asset: { findMany: async ({ where }) => {
      assert.deepEqual(JSON.parse(JSON.stringify(where)), { id: { in: [asset.id] }, owner_id: actor.id, type: 'image', status: 'active' });
      return [asset];
    } } };
    const originalsRead: string[] = [];
    const readOriginal = async (url: string, signal?: AbortSignal) => {
      assert.equal(url, asset.original_url, 'Image decode/render transport reads only the original PNG URL'); originalsRead.push(url);
      return media.readStudioImage(url, signal);
    };
    const originalIdentity = await hd.hdSource(asset.original_url); assert.ok(originalIdentity);
    const jobs: HdJob[] = [];
    for (const format of ['webp', 'avif'] as const) {
      const pipeline = sharp(original).rotate();
      const bytes = await (format === 'webp' ? pipeline.webp({ lossless: true }) : pipeline.avif({ quality: 95, chromaSubsampling: '4:4:4' })).toBuffer();
      assert.ok(bytes.length < original.length, 'Fixture ready HD must actually be smaller');
      const key = sha(`fixture-${format}`), file = `${key}.${format}`; await fs.writeFile(path.join(hdDirectory, file), bytes);
      const metadata = await sharp(bytes).metadata(); assert.equal(metadata.width, 80); assert.equal(metadata.height, 120);
      jobs.push({ key, file, source: asset.original_url, version: originalIdentity.version, status: 'ready', policy: hd.HD_POLICY,
        priority: 1, attempts: 1, updatedAt: '2026-11-01T00:00:00.000Z', preserveText: false,
        format, mime: `image/${format}`, bytes: bytes.length, width: metadata.width, height: metadata.height });
    }
    let lookup: () => Promise<HdJob | null> = async () => jobs[0];
    let representationMode = 'normal', comparisonMode = 'normal';
    const coverText = await source('src/lib/image-studio/module-cover.ts');
    const renderDeclaration = declarations('module-cover.ts', coverText, ['renderCover']);
    assert.equal(sha(renderDeclaration), baselineRenderSHA256, 'Original renderer declaration must remain unchanged');
    const coverDeclarations = declarations('module-cover.ts', coverText,
      ['ModuleCoverError', 'hash', 'validId', 'sourceVersion', 'authorizedSources', 'inspectSources', 'coverOutput', 'activeJobs', 'renderCover']);
    const makeCover = () => evaluate(`${coverDeclarations}\nexports.fixture = { sourceVersion, inspectSources, renderCover };`, {
      ...site, ...coverTypes, prisma: client, readStudioImage: readOriginal, studioTemplateAssetUrl: media.studioTemplateAssetUrl,
      studioHiddenAssetUrls: async () => hidden ? [asset.original_url] : [],
      lookupHd: async (url: string) => { assert.equal(url, asset.original_url); lookups++; return lookup(); },
      hdRepresentationVersion: async (url: string, job: HdJob) => {
        if (representationMode === 'throw') throw new Error('fixture representation uncertainty');
        return representationMode === 'missing' ? undefined : hd.hdRepresentationVersion(url, job);
      },
      comparisonOriginalVersion: async (url: string) => {
        if (comparisonMode === 'throw') throw new Error('fixture comparison uncertainty');
        const value = comparisonMode === 'missing' ? null : await comparison.comparisonOriginalVersion(url);
        if (comparisonMode === 'change-original') await fs.appendFile(originalFile, Buffer.from([0]));
        return value;
      },
    }).fixture as CoverFunctions;
    const baseline = makeCover(), candidate = makeCover();
    const version = await baseline.sourceVersion(asset);
    const recipe: ModuleCoverRecipe = { version: 2, layout: 'single', output: { width: 1280, height: 1280 },
      sources: [{ assetId: asset.id, version, crop: { x: 0, y: 0, width: 100, height: 100 * 80 / 120 } }] };
    originalsRead.length = 0;
    const baselineRender = await baseline.renderCover(actor, state, recipe);
    assert.deepEqual(originalsRead, [asset.original_url]); assert.equal(lookups, 0, 'Original renderer has no HD lookup');
    for (const job of jobs) {
      lookup = async () => job;
      const selected = (await candidate.inspectSources(actor, state, [asset.id], client))[0];
      const url = new URL(selected.previewUrl, 'https://fixture.invalid');
      assert.equal(url.pathname, media.studioTemplateAssetUrl(asset.id)); assert.equal(Array.from(url.searchParams).length, 4);
      assert.equal(url.searchParams.get('hd'), '1'); assert.equal(url.searchParams.get('hd-version'), job.version);
      assert.equal(url.searchParams.get('hd-representation'), await hd.hdRepresentationVersion(asset.original_url, job));
      assert.equal(url.searchParams.get('comparison-version'), await comparison.comparisonOriginalVersion(asset.original_url));
      assert.match(url.searchParams.get('comparison-version')!, /^cmp2-[a-f0-9]{64}$/);
      assert.equal(selected.version, version); assert.match(selected.version, /^[a-f0-9]{64}$/);
      assert.notEqual(selected.version, job.version); assert.notEqual(selected.version, url.searchParams.get('comparison-version'));
      assert.equal(selected.width, 80); assert.equal(selected.height, 120);
    }
    checks.push('ready_smaller_avif_webp_bind_four_url_fields_real_representation_cmp2_and_oriented_original_recipe_sha');
    originalsRead.length = 0; const lookupsBeforeRender = lookups;
    const selectedRender = await candidate.renderCover(actor, state, recipe);
    assert.deepEqual(originalsRead, [asset.original_url]); assert.equal(lookups, lookupsBeforeRender);
    imageSHA256 = sha(selectedRender.image); thumbnailSHA256 = sha(selectedRender.thumbnail);
    assert.equal(imageSHA256, sha(baselineRender.image)); assert.equal(thumbnailSHA256, sha(baselineRender.thumbnail));
    const imageMetadata = await sharp(selectedRender.image).metadata(), thumbnailMetadata = await sharp(selectedRender.thumbnail).metadata();
    assert.equal(imageMetadata.format, 'webp'); assert.equal(imageMetadata.width, 1280); assert.equal(imageMetadata.height, 1280);
    assert.equal(thumbnailMetadata.format, 'webp'); assert.equal(thumbnailMetadata.width, 640); assert.equal(thumbnailMetadata.height, 640);
    checks.push('real_original_png_percent_crop_renderer_unchanged_full_1280_and_640_webp_sha_match_baseline');

    const fallbackJobs: Array<HdJob | null> = [null,
      ...(['queued', 'running', 'failed', 'skipped'] as const).map(status => ({ ...jobs[0], status })),
      { ...jobs[0], format: 'original' }, { ...jobs[0], width: 79 }, { ...jobs[0], height: 119 },
      { ...jobs[0], bytes: original.length }, { ...jobs[0], bytes: original.length + 1 }];
    const expectOriginal = async () => {
      const selected = (await candidate.inspectSources(actor, state, [asset.id], client))[0];
      assert.equal(selected.previewUrl, media.studioTemplateAssetUrl(asset.id)); assert.equal(selected.version, version);
      assert.equal(selected.width, 80); assert.equal(selected.height, 120);
    };
    for (const job of fallbackJobs) { lookup = async () => job; await expectOriginal(); }
    lookup = async () => { throw new Error('fixture lookup uncertainty'); }; await expectOriginal();
    lookup = async () => jobs[0];
    for (const mode of ['missing', 'throw']) {
      representationMode = mode; await expectOriginal(); representationMode = 'normal';
      comparisonMode = mode; await expectOriginal(); comparisonMode = 'normal';
    }
    checks.push('nonready_wrong_dimensions_equal_or_larger_unknown_proofs_and_optional_hd_failures_keep_original_url');
    hidden = true; const lookupsBeforeDenial = lookups;
    await assert.rejects(candidate.inspectSources(actor, state, [asset.id], client), (error: unknown) => (error as { status?: number }).status === 403);
    assert.equal(lookups, lookupsBeforeDenial); hidden = false;
    checks.push('actual_authorized_sources_denial_precedes_optional_hd_lookup');
    for (const stage of ['lookup', 'comparison']) {
      lookup = stage === 'lookup' ? async () => { await fs.appendFile(originalFile, Buffer.from([0])); return jobs[0]; } : async () => jobs[0];
      comparisonMode = stage === 'comparison' ? 'change-original' : 'normal';
      await assert.rejects(candidate.inspectSources(actor, state, [asset.id], client), (error: unknown) => (error as { status?: number }).status === 409);
      comparisonMode = 'normal'; await fs.writeFile(originalFile, original);
    }
    checks.push('original_change_during_lookup_or_last_comparison_query_is_still_409_after_optional_reads');
    assert.equal(forbiddenCalls, 0);
    for (const file of sourceFiles) assert.equal(sha(await source(file)), sourceSHA256[file], `Source changed: ${file}`);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  const receipt = { schema: 'module-cover-hd-preview-fixture.v1', completed: true, synthetic: true, checks, sourceSHA256,
    baselineCommit, baselineRenderSHA256, imageSHA256, thumbnailSHA256, sharp: sharp.versions,
    temporaryFilesRemoved: true, applicationDatabaseOpened: false, productionDatabaseOpened: false, httpRequests: 0, forbiddenCalls,
    scope: 'Actual isolated inspectSources/proof/original-render declarations and real temporary PNG/Sharp; controlled authorized directory and HD lookup, not production authorization or browser acceptance' };
  if (process.argv[2]) {
    assert.ok(path.isAbsolute(process.argv[2])); await fs.writeFile(process.argv[2], JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(receipt));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
