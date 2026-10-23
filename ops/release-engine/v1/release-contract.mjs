import assert from 'node:assert/strict';
import { currentReleaseContext, isSharedEngine, assertSharedEngineContext } from './engine-context.mjs';

// Preparation only. Reconcile the HD release and lock the reviewed source before enabling.
const LEGACY_CONTRACT = Object.freeze({
  sourceReady: true,
  baselineReconciled: true,
  privateMultiviewInstall: true,
  normalContinuation: null,
  deployedUsageSchema: null,
  recoveredGuardBaseline: null,
  protectedIncrement: null,
  canvasVideoBatchSchema: null,
  deployedCanvasBatchSchema: null,
  recoveryRunId: '64295afe-13c2-46e0-b3f3-da32cb6c3bdb',
  closedCacheReference: '0656469f6700eb6ed9f06d6c5d0aa718de460c39965b5e58b54860780c8dd836.7054cb3b-8ab4-4864-8bf5-c9020e40b0ea',
  recoveryGuardSource: '154e95167f5469a12e8faf8705499109b0ff6990',
  mainSource: 'e01fb18045e2950b45323b4d4ca7f6ce143a2019',
  approvedMainFiles: ["package-lock.json","package.json","scripts/pricing-authoring-ui-contract-fixture.ts","src/app/admin/pricing/AdminPricingClient.tsx","src/app/admin/pricing/pricing.module.css","src/lib/pricing/admin-client-state.ts","src/lib/pricing/admin-contract.ts","src/lib/pricing/admin-display.ts","src/lib/pricing/catalog.ts","src/lib/pricing/policy.ts","src/lib/pricing/presets.ts","src/lib/release.ts","tasks/todo.md"],
  baselineSource: '154e95167f5469a12e8faf8705499109b0ff6990',
  retiredPricingSources: ['1f7eb77bf840fa40fef98fa62e8a63df8c944d6a'],
  sourceBase: '71cfea4b52f62603d9173bbbf6ff21c134cf0565',
  baselineVersion: '0.100.2+rate-fix-guard.1',
  baselineBuild: 'mZENC5Jpz-eFehAAAYd4_',
  starts: {
    web: [897134, '29afdce91e0d4f40ab2be1c443da783f', '18137571374071'],
    image: [897002, '8b6ee72ebff24769b19076c5ebda56c9', '18137568679080'],
    hd: [896896, '2d797f8573864a7bac8c075392732976', '18137567844073'],
    works: [61154, '499c1a0862234b628f24c51e68f60914', '17850674464137'],
    role: [1459688, '362b294ee3fd453b8e251b1e5de873ee', '17396778161849'],
    template: [1303839, 'fdf23a5f734c42a8a66e9f665f703fbb', '17113680233083'],
  },
  versions: { main: '0.100.2', guard: '0.100.2+rate-fix-guard.1' },
  mainBranch: 'codex/multiview-original-direct-hd-20261019',
  guardReference: 'refs/heads/codex/rate-fix-guard-20261020',
  guardDisplaySource: '71cfea4b52f62603d9173bbbf6ff21c134cf0565',
  guardDisplayFiles: [],
  guardChangedFiles: ["package-lock.json","package.json","scripts/pricing-authoring-ui-contract-fixture.ts","src/app/admin/pricing/AdminPricingClient.tsx","src/app/admin/pricing/pricing.module.css","src/lib/pricing/admin-client-state.ts","src/lib/pricing/admin-contract.ts","src/lib/pricing/admin-display.ts","src/lib/pricing/catalog.ts","src/lib/pricing/policy.ts","src/lib/pricing/presets.ts","src/lib/release.ts","tasks/todo.md"],
  pricingRevision: 'e5f4e227-55dc-4246-a971-a62107a42aa5',
  protectedVideoTaskIds: ['cmvfjnz9k002r7e1kvh1nf6tp', 'cmvfku6ey0008l3jz00y2lv7m', 'cmvfkw76s001dl3jzvdige8d9'],
  expectedAllowedSha256: 'ab2862ccaf7cd3908b9230bfd7f81093751712a0c8fa462b95f9264b1bbc4346',
});

// Shared execution loads a root-owned batch manifest before importing modules.
// The old default remains only for legacy callers and their compatibility tests.
export const MV_DIRECT = currentReleaseContext()?.contract || LEGACY_CONTRACT;

export function assertMvDirectReady() {
  assert.equal(MV_DIRECT.sourceReady, true, 'MV-DIRECT source is not ready; no packaging, reservation or release is permitted');
  assert.equal(MV_DIRECT.baselineReconciled, true, 'Reconcile the active HD release before freezing the MV-DIRECT baseline');
  assert.match(MV_DIRECT.mainSource, /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(MV_DIRECT.approvedMainFiles) && MV_DIRECT.approvedMainFiles.length > 0,
    'Lock the exact reviewed main diff and native fixture receipt contract');
}

// 本单只在已部署的 R17 保护版上增加生图修复，不能借发布名称恢复暂停能力。
export const PROTECTED_INCREMENT = Object.freeze({
  schema: 'sd2-protected-increment.v1',
  baselineSource: '31bff5a6544a3d18d433b81fa7735ed57b0d012c',
  pricingWrites: false, multiviewGeneration: false, canvasVideoBatchWrites: false,
  sizePolicyVersion: 2, diagnosticsSchema: 'image.provider-error.v1',
});
export const PROTECTED_INCREMENT_SOURCE_FILES = Object.freeze([
  'src/app/api/tasks/create/route.ts', 'src/lib/pricing/build-mode.ts', 'src/lib/canvas-video-batches-build-mode.ts',
  'src/lib/video/multiview-private-create.server.ts', 'src/lib/video/multiview-task-privacy.ts',
  'src/lib/video/multiview-recipe-storage.server.ts', 'scripts/install-multiview-private-recipe.ts',
  'scripts/backup-multiview-works.py',
]);
export function assertProtectedIncrement(value, context) {
  if (!value) return false;
  const shared = isSharedEngine(context);
  if (shared) assertSharedEngineContext(context);
  const expected = shared ? MV_DIRECT.protectedIncrement : PROTECTED_INCREMENT;
  assert.deepEqual(value, expected, 'Unknown or widened protected increment');
  for (const key of ['pricingWrites', 'multiviewGeneration', 'canvasVideoBatchWrites'])
    assert.equal(value[key], false, 'Protected publication cannot enable ' + key);
  assert.equal(value.sizePolicyVersion, 2);
  assert.equal(value.diagnosticsSchema, 'image.provider-error.v1');
  assert.equal(context.baselineSource ?? context.live?.web?.source, expected.baselineSource);
  assert.equal(context.recoveredGuardBaseline?.schema, 'sd2-multiview-r17-recovered-guard.v1');
  assert.equal(context.privateMultiviewInstall, true);
  assert.ok(context.deployedUsageSchema && context.deployedCanvasBatchSchema && context.canvasVideoBatchSchema);
  assert.equal(context.normalContinuation || null, null);
  if (!shared) assert.equal(context.reuseBuilds || null, null);
  return true;
}
export function assertProtectedIncrementCandidate(m, kind, read) {
  if (!assertProtectedIncrement(m.protectedIncrement, m)) return false;
  assert.ok(['main', 'guard'].includes(kind));
  for (const file of PROTECTED_INCREMENT_SOURCE_FILES)
    assert.equal(read(m[kind].root + '/' + file).toString(), read(m.live.web.root + '/' + file).toString(),
      'Protected admission/privacy source changed: ' + file);
  for (const [file, name] of [['src/lib/pricing/build-mode.ts', 'PRICING_ADMIN_WRITES_ENABLED'],
    ['src/lib/canvas-video-batches-build-mode.ts', 'CANVAS_VIDEO_BATCH_WRITES_ENABLED']])
    assert.equal(read(m[kind].root + '/' + file).toString().trim(), `export const ${name}: boolean = false;`);
  return true;
}
