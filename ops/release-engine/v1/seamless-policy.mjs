import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const REFERENCE_MEDIA_CHECKS = [
  { id: 'video-delivery', script: 'scripts/reference-video-delivery-engineering.ts', inputs: [
    'src/app/api/provider/reference-media/route.ts', 'src/lib/provider/reference-video-delivery.server.ts',
    'src/lib/provider/reference-video-delivery-build-mode.ts', 'src/lib/generation-retry/video.ts',
    'src/lib/generation-retry/store.ts', 'src/app/api/tasks/create/route.ts', 'src/app/api/ip/tasks/create/route.ts',
    'src/lib/provider/ip-reference-media-metadata.ts', 'src/lib/provider/reference-media-policy.ts',
    'src/lib/provider/jimeng.ts', 'src/lib/provider/volcengine-ip.ts', 'src/lib/media/preview-response.ts',
    'src/lib/reference-albums/permissions.ts', 'src/lib/assets/site-url.ts', 'src/lib/image-studio/protected-assets.ts'] },
  { id: 'provider-error', script: 'scripts/reference-create-diagnostic-engineering.ts', inputs: [
    'src/lib/provider/jimeng.ts', 'src/lib/provider/volcengine-ip.ts', 'src/lib/provider/reference-media-redaction.ts',
    'src/lib/provider/create-diagnostic.ts', 'src/lib/generation-retry/video.ts',
    'src/app/api/tasks/create/route.ts', 'src/app/api/ip/tasks/create/route.ts',
    'src/app/api/tasks/request-status/route.ts', 'src/app/api/assets/library/route.ts'] },
  { id: 'submission-state', script: 'scripts/video-submission-state-engineering.ts', inputs: [
    'src/components/generate/video-submission-state.ts', 'src/components/generate/GeneratePageClient.tsx'] },
  { id: 'image-cache', script: 'scripts/trusted-display-cache-engineering.ts', inputs: [
    'src/lib/image-studio/media.ts', 'src/lib/media/authorized-image-response.ts', 'src/lib/content-reactions/content.ts',
    'src/app/api/content-reactions/media/route.ts', 'src/app/api/reference-images/[id]/content/route.ts'] },
  { id: 'media-recovery', script: 'scripts/reference-media-recovery-engineering.ts', inputs: [
    'src/components/ReferenceThumb.tsx', 'src/components/ResourceLibraryPicker.tsx', 'src/lib/image-studio/media.ts',
    'src/lib/media/authorized-image-response.ts', 'src/app/api/content-reactions/media/route.ts',
    'src/app/api/reference-images/[id]/content/route.ts'] },
  { id: 'workspace-selection', script: 'scripts/asset-workspace-selection-engineering.ts', inputs: [
    'src/app/assets/page.tsx', 'src/lib/hooks/useWorkspace.ts', 'src/app/api/workspace/assets/route.ts', 'src/lib/assets/workspace.ts'] },
  { id: 'compatible-guard', script: 'scripts/seamless-compatible-guard-engineering.mjs', inputs: [
    'ops/release-engine/v1/seamless-web.mjs', 'ops/release-engine/v1/seamless-policy.mjs', 'ops/release-engine/v1/seamless-bridges.mjs'] },
].map(check => ({ ...check, inputs: [check.script, ...check.inputs] }));

export function referenceMediaChecksFor(previous, main) {
  if (!main.sourceFiles['src/app/api/provider/reference-media/route.ts']
    && !main.sourceFiles['scripts/trusted-display-cache-engineering.ts']) return [];
  return REFERENCE_MEDIA_CHECKS.filter(check => check.inputs.some(name => (previous.sourceFiles[name] ?? null) !== (main.sourceFiles[name] ?? null)));
}

export function verifyReferenceMediaEngineering(previous, main, focused, stage, readLog) {
  const checks = referenceMediaChecksFor(previous, main);
  if (!checks.length) return [];
  assert.equal(focused?.source, main.source, 'Scoped reference-media evidence must bind the candidate');
  for (const check of checks) {
    assert.ok(main.sourceFiles[check.script], 'Missing scoped engineering script: ' + check.script);
    const result = focused.referenceMedia?.[check.id];
    assert.equal(result?.script, check.script, 'Run selected reference-media check: ' + check.id);
    assert.equal(result.exitCode, 0); assert.equal(result.signal, null); assert.equal(result.error, null);
    assert.deepEqual(result.sourceSha256, Object.fromEntries(check.inputs.map(name => [name, main.sourceFiles[name] ?? null])));
    assert.equal(result.log, stage + '/reference-' + check.id + '.log');
    assert.equal(createHash('sha256').update(readLog(result.log)).digest('hex'), result.logSha256);
  }
  return checks.map(check => check.id);
}

export const DEFAULT_DELIVERY = Object.freeze({
  schema: 'sd2-release-delivery.v1', mode: 'seamless', primaryPort: 3302,
  candidatePort: 3303, recoveryPort: 3304, incompatible: 'retain-current-and-refuse', publicMaintenance: false,
});
export const SEAMLESS_CONTROL = '/data/video-api-debugger/controls/seamless-web-v1';
export const SEAMLESS_STATIC = '/data/video-api-debugger/seamless-static';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const CUSTOMER_API_MIGRATION = 'prisma/migrations/20261127200000_customer_api/migration.sql';

function persistedSchema(entry) {
  return Object.fromEntries(Object.entries(entry.sourceFiles).filter(([name]) =>
    name === 'prisma/schema.prisma' || name.startsWith('prisma/migrations/')));
}

// Admission precedes any service/configuration effect. A failure keeps the old site.
export function assertSeamlessCompatible(previous, main, guard, read, bridges, verifiedGuard = previous.releases[1]) {
  assert.deepEqual(guard, verifiedGuard, 'Recovery artifact must match the retained or fully verified compatible guard');
  const old = previous.releases[0]; assert.notEqual(main.source, old.source);
  const beforeSchema = persistedSchema(old), nextSchema = persistedSchema(main);
  const schemaChanges = [...new Set([...Object.keys(beforeSchema), ...Object.keys(nextSchema)])]
    .filter(file => beforeSchema[file] !== nextSchema[file]).sort();
  const customerApiMigration = schemaChanges.includes(CUSTOMER_API_MIGRATION);
  if (customerApiMigration) {
    assert.deepEqual(schemaChanges, [CUSTOMER_API_MIGRATION, 'prisma/schema.prisma'].sort(),
      'Only the reviewed customer API additive migration can be staged ahead of seamless delivery');
    assert.equal(beforeSchema[CUSTOMER_API_MIGRATION], undefined);
    assert.notEqual(guard.source, previous.releases[1].source, 'Schema migration needs a fresh compatible recovery build');
  }
  if (guard.source !== previous.releases[1].source) {
    assert.deepEqual(persistedSchema(guard), nextSchema, 'New compatible guard must retain the main persisted schema');
  } else assert.deepEqual(guard, previous.releases[1], 'Retain the exact existing compatible recovery artifact');
  const contract = file => file === 'prisma/schema.prisma' || file.startsWith('prisma/migrations/')
    || file.startsWith('src/app/api/') || file.startsWith('src/lib/')
    || /^scripts\/(?:process-|finalize-|server-runtime|canvas-role)/.test(file);
  const provenance = 'src/lib/image-studio/process-provenance.ts', sync = 'src/lib/image-studio/synchronous-admission.ts';
  const files = new Set([...Object.keys(old.sourceFiles), ...Object.keys(main.sourceFiles)]);
  for (const file of files) {
    if (!contract(file) || file === provenance || file === 'src/lib/release.ts' || old.sourceFiles[file] === main.sourceFiles[file]) continue;
    const bridge = bridges[file];
    if (bridge && (old.sourceFiles[file] ?? null) === bridge.previous && main.sourceFiles[file] === bridge.current) continue;
    if (file === sync) {
      const normalize = bytes => bytes.toString()
        .replace("import { synchronousProcessProvenance } from './process-provenance';\n", '')
        .replace(/  const provenance = synchronousProcessProvenance\(\);\n  if \(provenance\) await tx\.platformSetting\.create\(\{ data: \{\n    key: `image_sync_process_v1:\$\{input.ownerId\}:\$\{requestId\}`,\n    value_json: JSON.stringify\(\{ \.\.\.provenance, fingerprint: input.fingerprint \}\), updated_by: input.ownerId,\n  \} \}\);\n/, '');
      assert.equal(normalize(read(main.root + '/' + file)), normalize(read(old.root + '/' + file)), 'Synchronous protocol changed; retain current site');
    } else assert.fail('Persisted server contract needs staged compatibility: ' + file);
  }
  assert.equal(digest(read(main.root + '/' + provenance)), bridges[provenance].current, 'Unreviewed process provenance');
  for (const file of ['package.json', 'package-lock.json']) {
    const normalize = bytes => { const v = JSON.parse(bytes); delete v.version;
      if (v.packages?.['']) delete v.packages[''].version; return v; };
    assert.deepEqual(normalize(read(main.root + '/' + file)), normalize(read(old.root + '/' + file)), 'Runtime dependency change needs rolling compatibility');
  }
  return { schema: 'sd2-seamless-admission.v1', previousSource: old.source, mainSource: main.source,
    guardSource: guard.source, sameSchema: schemaChanges.length === 0, unchangedPersistedContracts: true,
    sqlExecuted: false, coldFallbackAllowed: false, ...(customerApiMigration ? { customerApiMigration: true } : {}) };
}
