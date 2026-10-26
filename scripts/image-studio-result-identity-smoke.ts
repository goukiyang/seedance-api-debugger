import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const fixtureOwnerId = 'generated-by-user';
const viewerId = 'current-viewer';
const templateAuthorId = 'template-author';
const missingOwnerId = 'deleted-generator';

type TaskFixture = {
  id: string;
  owner_id: string;
  deleted_at: Date | null;
  batch_id: string;
  ordinal: number;
  prompt: string;
  model: string;
  quality: string;
  status: string;
  error: null;
  unit_credits: number;
  provider_cost_usd: number | null;
  aspect_ratio: string;
  output_size: string | null;
  created_at: Date;
  finished_at: Date | null;
  reference_ids: string;
  snapshot_json: null;
  asset_id: null;
  source_preset_id: string | null;
};

type SmokeApi = {
  listStudioTasks: (ownerId: string) => Promise<{ tasks: Array<{ id: string; owner: Record<string, unknown> | null }> }>;
  models: readonly string[];
  shortLabels: Record<string, string>;
};

function task(id: string, ownerId: string, sourcePresetId: string | null = null): TaskFixture {
  return {
    id, owner_id: ownerId, deleted_at: null, batch_id: `batch-${id}`, ordinal: 1,
    prompt: 'fixture prompt', model: 'gemini-3.1-flash-image-preview', quality: 'auto',
    status: 'succeeded', error: null, unit_credits: 1, provider_cost_usd: null,
    aspect_ratio: '1:1', output_size: null, created_at: new Date(0), finished_at: null,
    reference_ids: '[]', snapshot_json: null, asset_id: null, source_preset_id: sourcePresetId,
  };
}

async function main() {
  const esbuild = requireFromRoot('esbuild');
  assert.ok(esbuild?.build, 'esbuild does not export build()');

  const fixtures = [
    task('generator-task', fixtureOwnerId, templateAuthorId),
    task('viewer-task', viewerId),
    task('template-author-task', templateAuthorId),
    task('orphan-task', missingOwnerId),
  ];
  const users = new Map([
    [fixtureOwnerId, { id: fixtureOwnerId, name: 'Actual generator', username: 'feishu_generator', avatar_url: '/generator.png' }],
    [viewerId, { id: viewerId, name: 'Current viewer', username: 'viewer', avatar_url: '/viewer.png' }],
    [templateAuthorId, { id: templateAuthorId, name: 'Template author', username: 'author', avatar_url: '/author.png' }],
  ]);
  const taskQueries: Array<{ owner_id?: string; deleted_at?: null }> = [];
  const ownerLookups: string[] = [];
  const prismaMock = {
    imageStudioTask: {
      findMany: async ({ where }: { where: { owner_id?: string; deleted_at?: null } }) => {
        taskQueries.push(where);
        return fixtures.filter(row => row.owner_id === where.owner_id && row.deleted_at === where.deleted_at);
      },
    },
    asset: { findMany: async () => [] },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        ownerLookups.push(where.id);
        return users.get(where.id) || null;
      },
    },
  };

  const entry = `
    import { listStudioTasks } from ${JSON.stringify(path.join(root, 'src/lib/image-studio/tasks'))};
    import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_SHORT_LABELS } from ${JSON.stringify(path.join(root, 'src/lib/image-studio/model-catalog'))};
    (globalThis as any).__imageStudioResultIdentityApi = {
      listStudioTasks, models: IMAGE_STUDIO_MODELS, shortLabels: IMAGE_STUDIO_MODEL_SHORT_LABELS,
    };
  `;
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: { contents: entry, loader: 'ts', resolveDir: root, sourcefile: 'image-studio-result-identity-entry.ts' },
    bundle: true,
    write: false,
    outfile: '/tmp/image-studio-result-identity-smoke.js',
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    tsconfig: path.join(root, 'tsconfig.json'),
    plugins: [{
      name: 'mock-prisma',
      setup(build: any) {
        build.onResolve({ filter: /^@\/lib\/prisma$/ }, () => ({ path: 'mock-prisma', namespace: 'identity-smoke' }));
        build.onLoad({ filter: /.*/, namespace: 'identity-smoke' }, () => ({
          contents: 'export const prisma = globalThis.__imageStudioResultIdentityPrisma;',
          loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  const javascript = built.outputFiles.find((file: { path: string }) => file.path.endsWith('.js'))?.text;
  assert.ok(javascript, 'esbuild did not emit the smoke bundle');

  const runtime = globalThis as typeof globalThis & {
    __imageStudioResultIdentityPrisma?: typeof prismaMock;
    __imageStudioResultIdentityApi?: SmokeApi;
  };
  runtime.__imageStudioResultIdentityPrisma = prismaMock;
  const bundleModule = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', javascript)(requireFromRoot, bundleModule, bundleModule.exports);
  const api = runtime.__imageStudioResultIdentityApi;
  assert.ok(api, 'smoke bundle did not expose the real implementations');

  const expectedModels = [
    'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'gpt-image-2',
    'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
  ];
  assert.deepEqual(api.models, expectedModels, 'image model IDs must remain unchanged');
  assert.deepEqual(api.shortLabels, {
    'gemini-3.1-flash-image-preview': 'ba2',
    'gemini-3-pro-image-preview': 'baPro',
    'gpt-image-2': 'img2',
    'gpt-image-2.5-flare': 'img2.5-F',
    'gpt-image-2.5-sunburst': 'img2.5-S',
  });

  const own = await api.listStudioTasks(fixtureOwnerId);
  assert.deepEqual(own.tasks.map(item => item.id), ['generator-task'], 'task query must isolate the requested owner');
  assert.equal(taskQueries[0]?.owner_id, fixtureOwnerId);
  assert.equal(taskQueries[0]?.deleted_at, null);
  assert.equal(ownerLookups[0], fixtureOwnerId, 'generator identity must be read by the task owner ID');
  assert.deepEqual(own.tasks[0]?.owner, {
    id: fixtureOwnerId, name: 'Actual generator', avatar_url: '/generator.png',
  }, 'result DTO must contain only the actual generator identity fields');
  assert.notEqual(own.tasks[0]?.owner?.id, viewerId);
  assert.notEqual(own.tasks[0]?.owner?.id, templateAuthorId);

  const orphan = await api.listStudioTasks(missingOwnerId);
  assert.equal(orphan.tasks[0]?.owner, null, 'a missing owner must not fall back to viewer or template author');
  assert.equal(ownerLookups[1], missingOwnerId);

  delete runtime.__imageStudioResultIdentityPrisma;
  delete runtime.__imageStudioResultIdentityApi;
  console.log('PASS: model labels/IDs and generated-owner identity DTO with isolated in-memory Prisma mock.');
}

void main().catch(error => {
  delete (globalThis as any).__imageStudioResultIdentityPrisma;
  delete (globalThis as any).__imageStudioResultIdentityApi;
  console.error(error);
  process.exitCode = 1;
});
