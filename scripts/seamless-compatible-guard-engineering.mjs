import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readCurrentBuildEvidence, readCompatibleGuardEvidence, remapStartupRelease } from '../ops/release-engine/v1/seamless-web.mjs';
import { REFERENCE_MEDIA_CHECKS, referenceMediaChecksFor, verifyReferenceMediaEngineering, assertSeamlessCompatible } from '../ops/release-engine/v1/seamless-policy.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const readers = ['src/app/api/provider/reference-media/route.ts', 'src/lib/provider/reference-video-delivery.server.ts',
  'src/lib/generation-retry/video.ts', 'src/lib/generation-retry/store.ts', 'src/lib/provider/jimeng.ts',
  'src/lib/provider/create-diagnostic.ts', 'src/lib/provider/reference-media-redaction.ts', 'src/lib/image-studio/process-provenance.ts'];
const flag = 'src/lib/provider/reference-video-delivery-build-mode.ts';
const stage = '/data/video-api-debugger/release-staging/compatible-guard-fixture';
const now = Date.parse('2026-11-14T19:00:00Z');
const checks = [];
function fixture() {
  const sourceFiles = Object.fromEntries([...readers, 'prisma/schema.prisma'].map(name => [name, hash(name)]));
  const entry = (source, files) => ({ root: '/data/video-api-debugger/managed-releases/' + source,
    source, version: '0.148.23', build: source.slice(0, 10), sourceFiles: files, buildFiles: { server: hash('compiled') } });
  const main = entry('a'.repeat(40), { ...sourceFiles, [flag]: hash('main-issuer') });
  const guard = entry('b'.repeat(40), { ...sourceFiles, [flag]: hash('guard-no-issuer') });
  const previous = entry('c'.repeat(40), {});
  return { main, guard, previous, files: new Map(),
    mainFlag: '// Preserve compatible readers.\nexport const PROVIDER_REFERENCE_MEDIA_ISSUANCE_ENABLED = true;\n',
    guardFlag: '// Preserve compatible readers.\nexport const PROVIDER_REFERENCE_MEDIA_ISSUANCE_ENABLED = false;\n' };
}
function documents(f, mutate = () => {}) {
  const put = (name, value) => f.files.set(name, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  put(stage + '/prepared-pricing-writer-v1.json', { releases: [f.main, f.guard] });
  for (const [kind, entry] of [['main', f.main], ['guard', f.guard]]) {
    const nativeFile = stage + '/' + kind + '-native.json';
    const freshGuard = kind === 'guard' && f.freshGuard === true;
    if (freshGuard) {
      const child = stage + '/guard-fresh-child.json'; put(child, { completed: true, productionWrites: 0 });
      const recorded = { receipt: child, sha256: hash(f.files.get(child)) };
      put(nativeFile, { schema: 'image-recovery-build-gate.v1', candidateRoot: entry.root, completed: true,
        startedAt: now - 3_602_000, finishedAt: now - 3_601_000, sourceSha256: { ...entry.sourceFiles },
        fixtures: [recorded], publicUsageFixtures: [recorded] });
    } else put(nativeFile, { source: entry.source, passed: true, completeMatrix: true, runtimeCompatibilityDeltaVerified: true,
      productionWrites: 0, paidRequests: 0, browserRuns: 0 });
    const proof = { kind, source: entry.source, version: entry.version, build: entry.build, stagingRoot: stage,
      fullNextBuildPassed: true, fullTypeAndLintIncluded: true, isolatedBuildDatabase: true, deployed: false,
      completedAt: new Date(now - (kind === 'guard' ? 3_600_000 : 1000)).toISOString() };
    const inputs = { 'source.json': { source: entry.source, files: entry.sourceFiles },
      'next-build.log': 'next completed', 'complete-types.log': 'types completed',
      'pricing-prepared.json': { source: entry.source, nativePrebuildPassed: true, freshPricingPassed: true,
        ...(freshGuard ? { nativePrebuildFresh: true } : {}),
        nativeEvidence: { receipt: nativeFile, receiptSha256: hash(f.files.get(nativeFile)) } } };
    for (const phase of ['next', 'types']) inputs[phase + '-process.json'] = { source: entry.source,
      exitCode: 0, signal: null, error: null, startedAt: new Date(now - 7_200_000).toISOString(), finishedAt: proof.completedAt };
    mutate(kind, proof, inputs);
    for (const [name, value] of Object.entries(inputs)) put(stage + '/' + kind + '-' + name, value);
    for (const [key, name] of Object.entries({ sourceManifestSha256: 'source.json', nextBuildLogSha256: 'next-build.log',
      completeTypesLogSha256: 'complete-types.log', pricingPreparedSha256: 'pricing-prepared.json',
      nextProcessReceiptSha256: 'next-process.json', typesProcessReceiptSha256: 'types-process.json' })) {
      proof[key] = hash(f.files.get(stage + '/' + kind + '-' + name));
    }
    put(stage + '/' + kind + '-build-success.json', proof);
  }
  put(f.main.root + '/' + flag, f.mainFlag);
  put(f.guard.root + '/' + flag, f.guardFlag);
  return { read: name => { assert.ok(f.files.has(name), 'missing evidence: ' + name); return f.files.get(name); },
    now: () => now, verify: entry => assert.ok([f.main, f.guard].some(expected => expected.source === entry.source)) };
}
const check = (name, run) => { run(); checks.push(name); };
check('fresh-main-full-evidence-and-retained-compatible-guard-selected', () => {
  const f = fixture(), options = documents(f), file = stage + '/main-build-success.json';
  const main = readCurrentBuildEvidence(file, options);
  assert.deepEqual(readCompatibleGuardEvidence(file, main, f.previous, options), f.guard);
});
check('same-guard-retains-existing-release-path-without-new-proof', () => {
  const f = fixture(); f.main.sourceFiles = {}; f.guard = f.previous; const options = documents(f);
  f.files.delete(stage + '/guard-build-success.json');
  assert.deepEqual(readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options), f.previous);
});
check('original-fresh-guard-gate-format-retains-original-times-and-source-binding', () => {
  const f = fixture(); f.freshGuard = true; const options = documents(f);
  assert.deepEqual(readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options), f.guard);
});
check('fresh-guard-child-receipt-mutation-refused', () => {
  const f = fixture(); f.freshGuard = true; const options = documents(f);
  f.files.set(stage + '/guard-fresh-child.json', Buffer.from('modified after original gate'));
  assert.throws(() => readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options));
});
check('selected-new-guard-passes-actual-rolling-admission', () => {
  const f = fixture(), options = documents(f);
  const guard = readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options);
  const bridges = Object.fromEntries(Object.entries(f.main.sourceFiles).map(([name, current]) => [name, { previous: null, current }]));
  const read = file => /\/package(?:-lock)?\.json$/.test(file) ? Buffer.from('{"version":"fixture"}') : Buffer.from(file.slice(f.main.root.length + 1));
  const admitted = assertSeamlessCompatible({ releases: [f.previous, f.previous] }, f.main, guard, read, bridges, guard);
  assert.equal(admitted.guardSource, f.guard.source);
  assert.equal(admitted.sqlExecuted, false);
});
check('immutable-main-capsule-does-not-select-unverified-new-guard', () => {
  const f = fixture(); f.main.sourceFiles = {};
  assert.equal(readCompatibleGuardEvidence(stage + '/immutable-main.json', f.main, f.previous,
    { read: () => { throw new Error('capsule must retain its admitted guard'); } }), f.previous);
});
check('existing-guard-missing-new-reader-refused-before-issuance', () => {
  const f = fixture(); f.guard = f.previous; const options = documents(f);
  assert.throws(() => readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options), /reader differs/);
});
check('same-compatible-guard-retains-original-build-without-rebuild', () => {
  const f = fixture(); f.previous = f.guard; const options = documents(f); f.files.delete(stage + '/guard-build-success.json');
  assert.equal(readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options), f.previous);
});
check('capsule-cannot-borrow-old-guard-for-new-protocol', () => {
  const f = fixture();
  assert.throws(() => readCompatibleGuardEvidence(stage + '/immutable-main.json', f.main, f.previous), /reader differs/);
});
check('missing-guard-build-evidence-refused', () => {
  const f = fixture(), options = documents(f); f.files.delete(stage + '/guard-build-success.json');
  assert.throws(() => readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options), /missing evidence/);
});
check('failed-guard-next-process-refused-even-with-consistent-log-hashes', () => {
  const f = fixture(), options = documents(f, (kind, _proof, inputs) => { if (kind === 'guard') inputs['next-process.json'].exitCode = 1; });
  assert.throws(() => readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options));
});
check('guard-with-incomplete-full-build-refused', () => {
  const f = fixture(), options = documents(f, (kind, proof) => { if (kind === 'guard') proof.fullTypeAndLintIncluded = false; });
  assert.throws(() => readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options));
});
check('reader-and-worker-source-mismatch-refused', () => {
  const f = fixture(); f.guard.sourceFiles[readers[2]] = hash('incompatible retry worker'); const options = documents(f);
  assert.throws(() => readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options), /reader differs/);
});
check('guard-new-issuance-enabled-refused', () => {
  const f = fixture(); f.guardFlag = 'export const PROVIDER_REFERENCE_MEDIA_ISSUANCE_ENABLED = true;'; const options = documents(f);
  assert.throws(() => readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options));
});
check('different-persisted-schema-refused', () => {
  const f = fixture(); f.guard.sourceFiles['prisma/schema.prisma'] = hash('changed schema'); const options = documents(f);
  assert.throws(() => readCompatibleGuardEvidence(stage + '/main-build-success.json', f.main, f.previous, options));
});
check('main-freshness-and-original-times-still-required', () => {
  const f = fixture(), options = documents(f, (kind, proof) => { if (kind === 'main') proof.completedAt = new Date(now - 1_800_001).toISOString(); });
  assert.throws(() => readCurrentBuildEvidence(stage + '/main-build-success.json', options), /fresh full build/);
});
check('both-auxiliary-startup-memberships-follow-verified-main-and-guard', () => {
  const f = fixture(), prior = { ...f.previous, sourceSha256: { [readers[0]]: hash('old-reader') }, readerContract: 'retained-reader-v1' };
  for (const target of [f.main, f.guard]) {
    const mapped = remapStartupRelease(prior, target);
    assert.equal(mapped.source, target.source); assert.equal(mapped.root, target.root); assert.equal(mapped.build, target.build);
    assert.equal(mapped.readerContract, prior.readerContract);
    assert.deepEqual(mapped.sourceSha256, { [readers[0]]: target.sourceFiles[readers[0]] });
  }
});
check('auxiliary-startup-guard-cannot-drop-required-reader-input', () => {
  const f = fixture(), prior = { sourceSha256: { missingReader: hash('required') } };
  assert.throws(() => remapStartupRelease(prior, f.guard), /reader missing/);
});
function routingFixture() {
  const inputs = Object.fromEntries(REFERENCE_MEDIA_CHECKS.flatMap(check => check.inputs.map(name => [name, hash(name)])));
  const previous = { source: 'old', sourceFiles: inputs }, main = { source: 'new', sourceFiles: { ...inputs } };
  return { previous, main };
}
check('unrelated-pricing-change-does-not-run-media-specials', () => {
  const f = routingFixture(); f.main.sourceFiles['src/lib/pricing/runtime.ts'] = hash('rate-only');
  assert.deepEqual(referenceMediaChecksFor(f.previous, f.main), []);
  assert.deepEqual(verifyReferenceMediaEngineering(f.previous, f.main, null, stage, () => { throw Error('must not read evidence'); }), []);
});
check('image-cache-change-selects-only-cache-and-read-recovery-consumers', () => {
  const f = routingFixture(); f.main.sourceFiles['src/lib/image-studio/media.ts'] = hash('new-cache-version');
  assert.deepEqual(referenceMediaChecksFor(f.previous, f.main).map(check => check.id), ['image-cache', 'media-recovery']);
});
check('sdk-change-selects-only-video-delivery-and-error-consumers', () => {
  const f = routingFixture(); f.main.sourceFiles['src/lib/provider/jimeng.ts'] = hash('new-sdk');
  assert.deepEqual(referenceMediaChecksFor(f.previous, f.main).map(check => check.id), ['video-delivery', 'provider-error']);
});
check('changed-media-contract-cannot-publish-without-same-source-engineering', () => {
  const f = routingFixture(); f.main.sourceFiles['src/lib/image-studio/media.ts'] = hash('new-cache-version');
  assert.throws(() => verifyReferenceMediaEngineering(f.previous, f.main, null, stage, () => Buffer.from('')));
});
check('selected-evidence-binds-input-bytes-process-result-and-log', () => {
  const f = routingFixture(); f.main.sourceFiles['src/lib/image-studio/media.ts'] = hash('new-cache-version');
  const focused = { source: f.main.source, referenceMedia: {} }, logs = new Map();
  for (const check of referenceMediaChecksFor(f.previous, f.main)) {
    const log = stage + '/reference-' + check.id + '.log', bytes = Buffer.from('actual-case-fixture:' + check.id); logs.set(log, bytes);
    focused.referenceMedia[check.id] = { script: check.script, exitCode: 0, signal: null, error: null,
      sourceSha256: Object.fromEntries(check.inputs.map(name => [name, f.main.sourceFiles[name] ?? null])), log, logSha256: hash(bytes) };
  }
  const readLog = name => logs.get(name);
  assert.deepEqual(verifyReferenceMediaEngineering(f.previous, f.main, focused, stage, readLog), ['image-cache', 'media-recovery']);
  focused.referenceMedia['image-cache'].sourceSha256['src/lib/image-studio/media.ts'] = hash('stale-old-worktree');
  assert.throws(() => verifyReferenceMediaEngineering(f.previous, f.main, focused, stage, readLog));
});
console.log(JSON.stringify({ passed: true, checks, productionWrites: 0, providersCalled: 0,
  evidenceKind: 'actual-guard-selection-functions-with-controlled-filesystem-boundary' }));
