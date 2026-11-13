import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const DEFAULT_DELIVERY = Object.freeze({
  schema: 'sd2-release-delivery.v1', mode: 'seamless', primaryPort: 3302,
  candidatePort: 3303, recoveryPort: 3304, incompatible: 'retain-current-and-refuse', publicMaintenance: false,
});
export const SEAMLESS_CONTROL = '/data/video-api-debugger/controls/seamless-web-v1';
export const SEAMLESS_STATIC = '/data/video-api-debugger/seamless-static';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Admission precedes any service/configuration effect. A failure keeps the old site.
export function assertSeamlessCompatible(previous, main, guard, read, bridges) {
  assert.deepEqual(guard, previous.releases[1], 'Retain the exact existing compatible recovery artifact');
  const old = previous.releases[0]; assert.notEqual(main.source, old.source);
  const contract = file => file === 'prisma/schema.prisma' || file.startsWith('prisma/migrations/')
    || file.startsWith('src/app/api/') || file.startsWith('src/lib/')
    || /^scripts\/(?:process-|finalize-|server-runtime|canvas-role)/.test(file);
  const provenance = 'src/lib/image-studio/process-provenance.ts', sync = 'src/lib/image-studio/synchronous-admission.ts';
  const files = new Set([...Object.keys(old.sourceFiles), ...Object.keys(main.sourceFiles)]);
  for (const file of files) {
    if (!contract(file) || file === provenance || file === 'src/lib/release.ts' || old.sourceFiles[file] === main.sourceFiles[file]) continue;
    const bridge = bridges[file];
    if (bridge && old.sourceFiles[file] === bridge.previous && main.sourceFiles[file] === bridge.current) continue;
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
    guardSource: guard.source, sameSchema: true, unchangedPersistedContracts: true, sqlExecuted: false, coldFallbackAllowed: false };
}
