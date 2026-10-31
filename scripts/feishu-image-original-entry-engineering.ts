import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from '../src/lib/image-studio/dimension-mismatch';

async function main() {
  let user: { id: string } | null = null, canUse = true, canRead = true, taskReads = 0, assetReads = 0;
  let task: { asset_id: string; status: string; usage_json: null } | null = { asset_id: 'fixture-asset', status: 'succeeded', usage_json: null };
  const asset = { id: 'fixture-asset', owner_id: 'fixture-owner', original_url: '/uploads/assets/fixture.png' };
  const jump = (path: string): never => { throw new Error(`redirect:${path}`); };
  const modules: Record<string, unknown> = {
    'next/navigation': { redirect: jump, notFound: () => { throw new Error('not_found'); } },
    '@/lib/auth/session': { getSession: async () => user },
    '@/lib/image-studio/access': { canUseCompanyTemplates: () => canUse },
    '@/lib/image-studio/protected-assets': { canReadStudioAsset: async (actualUser: unknown, actualAsset: unknown) => {
      assert.equal(actualUser, user); assert.equal(actualAsset, asset); return canRead;
    } },
    '@/lib/image-studio/dimension-mismatch': { studioOutputTaskWhere, studioTaskHasViewableOutput },
    '@/lib/prisma': { prisma: {
      imageStudioTask: { findFirst: async (args: { where: unknown }) => {
        taskReads++; assert.deepEqual(JSON.parse(JSON.stringify(args.where)), { owner_id: 'fixture-owner', asset_id: 'fixture-asset', deleted_at: null, AND: [studioOutputTaskWhere] }); return task;
      } },
      asset: { findFirst: async (args: { where: unknown }) => {
        assetReads++; assert.deepEqual(JSON.parse(JSON.stringify(args.where)), { id: 'fixture-asset', owner_id: 'fixture-owner', status: 'active', type: 'image' }); return asset;
      } },
    } },
  };
  const file = 'src/app/image-studio/original/[assetId]/page.tsx';
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const output = { exports: {} as { default?: (props: { params: { assetId: string } }) => Promise<never> } };
  vm.runInNewContext(source, { exports: output.exports, module: output, require: (id: string) => { assert.ok(Object.hasOwn(modules, id), id); return modules[id]; }, encodeURIComponent }, { filename: file });
  const open = () => output.exports.default!({ params: { assetId: 'fixture-asset' } });
  await assert.rejects(open, { message: 'redirect:/login?next=%2Fimage-studio%2Foriginal%2Ffixture-asset' });
  assert.equal(taskReads, 0); assert.equal(assetReads, 0);
  user = { id: 'fixture-owner' }; canUse = false; await assert.rejects(open, { message: 'not_found' }); assert.equal(taskReads, 0);
  canUse = true; task = null; await assert.rejects(open, { message: 'not_found' }); assert.equal(assetReads, 0);
  task = { asset_id: 'fixture-asset', status: 'succeeded', usage_json: null }; canRead = false; await assert.rejects(open, { message: 'not_found' });
  canRead = true; await assert.rejects(open, { message: 'redirect:/api/image-studio/assets/fixture-asset' });
  console.log(JSON.stringify({ passed: true, cases: 1, checks: ['login_returns_to_same_site_original_entry', 'owner_completed_task_and_active_asset_permission_required', 'authorized_entry_reuses_protected_original_get'], applicationDatabaseOpened: false, networkCalls: 0, productionWrites: 0 }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
