import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MV_DIRECT } from './release-contract.mjs';
import { readPublishedBaselineSourceFiles } from './deployed-usage-schema.mjs';

export const LEGACY_SOURCE = MV_DIRECT.baselineSource;
export const LEGACY_SOURCE_FILES = {
  "src/app/api/assets/generate/route.ts": "75e2fca75546c6e1a2490bd4e7ac0f2076458fa07febe6cd295f31730f9939e0",
  "src/lib/integrations/image-generation.ts": "29c1c47f1a406778dce52539162091c2215d0f468e903f1cefb99f313918b5f9",
  "src/lib/image-studio/synchronous-admission.ts": "6318f32ed3dc737ad12ec0675ca1a2a6656c9e5a55dcf3ffcaa9acdd1fa58447",
  "src/lib/image-studio/queue-capacity.ts": "d15f9893fac35a478f03944dfb518a33c2628453ca8185127c603e6380003671",
  "src/lib/image-studio/tasks.ts": "47220617e78273bb3386615bdd537893aa4e0299794dec18d2fc7d60e731174c",
  "src/lib/image-studio/batches.ts": "9f656950d10035e816061d1846d5547cf1a1392a1e70702a7f0130e455934727",
  "src/lib/image-studio/worker.ts": "8e10bd5ebb28a0d4786d3da2caa87e74c0acc9919762aaf454085d6667197dce",
  "src/lib/tools/toolflow-runtime.ts": "bdc1012a719dbafb575e3618e0ff52474397fd2822e79925de91348a40adfb7e",
  "src/lib/avatar-random/service.ts": "f9b8c1a205aa62b8205cfb891732d8c7b6b4f0f6551cbf38b2ed79ef5932ddcd",
  "src/lib/assets/upload-similarity.ts": "59133828a49e8c4891eaee36aade269e4f154b3298b57b9357fb2744f70ca5cd"
};
export const LEGACY_EXECUTION_CONTRACT = Object.freeze({
  source: LEGACY_SOURCE,
  synchronous: {
    soleCaller: 'src/app/api/assets/generate/route.ts:540',
    committedAdmission: 'src/app/api/assets/generate/route.ts:535',
    finalization: 'src/app/api/assets/generate/route.ts:678',
    reservation: 'reserveImageStudioQueueCapacity + createSynchronousImageAdmission in one awaited transaction',
    completePromise: 'createImageGeneration awaits Promise.allSettled of all studio/Gemini slots; other adapters are awaited',
    localTimeoutIsNotProviderTermination: true,
  },
  chargedCreationGates: [
    { entry: 'template/single/avatar/canvas images and styles', gate: 'src/lib/image-studio/tasks.ts:750 reserveImageStudioQueueCapacity in submit transaction', pricing: 'accepted contract + assertPricingImageConsumerReady' },
    { entry: 'batch dispatch', gate: 'src/lib/image-studio/batches.ts:526,538 pricing readiness then shared capacity in creation transaction', pricing: 'frozen parent/item contract' },
    { entry: 'toolflow create/retry/continuation', gate: 'src/lib/tools/toolflow-runtime.ts:769 reserveImageStudioQueueCapacity in createToolFlowStudioTasks', pricing: 'signed quote + frozen accepted contract' },
    { entry: 'synchronous assets/generate compatibility path', gate: 'src/app/api/assets/generate/route.ts:535-540 committed shared capacity/admission before POST', pricing: 'withImagePricing earlier in route' },
  ],
  finalPostGates: [
    { entry: 'queued ordinary/channel studio task', gate: 'src/lib/image-studio/worker.ts assertLease + assertStudioPostAuthorization before generate',
      guarantees: 'fresh task state, lease, frozen template, pricing reader and actual-charge deadline',
      ordinaryDrainRecheckedAtFinalPost: false },
    { entry: 'synchronous compatibility request', gate: 'committed synchronous admission before createImageGeneration',
      ordinaryDrainRecheckedAtFinalPost: false },
  ],
  storageEntrypoints: ['studio-delivery', 'studio-billing', 'studio-response-evidence', 'studio-thumbnails',
    'studio-viewer-receipts', 'module-covers', 'verified-uploads', 'hd-derivatives', 'hd-worker.lock', 'upload-similarity-detail'],
  externalDataEntrypoints: ['public/uploads', 'public/videos', '/data/video-api-debugger/var-lib/storage/multiview-works',
    '/data/video-api-debugger/var-lib/storage/multiview-cache'],
  drainAloneProvesOldWritersStopped: false,
});
export function captureLegacySourceContract({ legacyRoot, manifest = null }) {
  rootOnly(); inside(legacyRoot); assert.equal(fs.realpathSync(legacyRoot), legacyRoot);
  assert.equal(fs.readFileSync(path.join(legacyRoot, '.deployed-commit'), 'utf8').trim(), LEGACY_SOURCE);
  // The original static map still governs first publication/continuation. A newer
  // deployed source must instead be proven by the exact prior publication bytes.
  assert.deepEqual(manifest?.deployedUsageSchema || null, MV_DIRECT.deployedUsageSchema || null);
  const published = manifest?.deployedUsageSchema
    ? readPublishedBaselineSourceFiles(manifest, [...Object.keys(LEGACY_SOURCE_FILES), 'scripts/process-image-studio.ts']) : null;
  if (published) {
    assert.equal(published.source, LEGACY_SOURCE); assert.equal(published.root, legacyRoot);
  }
  const sourceFiles = published?.sourceFiles || LEGACY_SOURCE_FILES;
  for (const [file, expected] of Object.entries(sourceFiles)) {
    const target = path.join(legacyRoot, file);
    assert.equal(fs.realpathSync(target), target);
    assert.equal(sha(fs.readFileSync(target)), expected, file);
  }
  const route = fs.readFileSync(path.join(legacyRoot, 'src/app/api/assets/generate/route.ts'), 'utf8');
  const committed = route.indexOf('synchronousAdmission = await prisma.$transaction(');
  const post = route.indexOf('const providerResult = await createImageGeneration(');
  const finalization = route.lastIndexOf('if (synchronousAdmission) await finishSynchronousImageAdmission(');
  assert.ok(committed > 0 && post > committed && finalization > post);
  const admission = route.slice(committed, post);
  assert.ok(admission.includes('await reserveImageStudioQueueCapacity(')
    && admission.includes('return createSynchronousImageAdmission('));
  assert.equal(route.split('await createImageGeneration(').length, 2);
  const integration = fs.readFileSync(path.join(legacyRoot, 'src/lib/integrations/image-generation.ts'), 'utf8');
  const generator = integration.slice(integration.indexOf('export async function createImageGeneration('));
  assert.ok(generator.includes('const completed = await Promise.allSettled(attempts);'));
  assert.ok(generator.includes('return await createOpenAiImageGeneration(') && generator.includes('return await createGeminiImageGeneration('));
  assert.ok(generator.includes('} finally {\n    clearTimeout(timeout);'));
  for (const file of ['src/lib/image-studio/tasks.ts', 'src/lib/image-studio/batches.ts', 'src/lib/tools/toolflow-runtime.ts'])
    assert.ok(fs.readFileSync(path.join(legacyRoot, file), 'utf8').includes('await reserveImageStudioQueueCapacity('),
      'Shared charged-creation gate missing: ' + file);
  const worker = fs.readFileSync(path.join(legacyRoot, 'src/lib/image-studio/worker.ts'), 'utf8');
  for (const text of ['await assertLease();', 'await assertStudioPostAuthorization(task);',
    'assertFrozenSharedStudioTask(current);', 'await assertPricingImageConsumerReady(prisma)',
    'current.billing_deadline <= new Date()', 'Date.parse(contract.deadline!) <= Date.now()'])
    assert.ok(worker.includes(text), 'Final POST authorization contract changed');
  return { ...LEGACY_EXECUTION_CONTRACT, sourceFiles,
    ...(published ? { publishedBaseline: published } : {}), checkedAt: Date.now() };
}
export function captureLegacyWriterContracts(m) {
  return [...new Set(['web', 'image'].map(role => m.live[role].root))].map(legacyRoot => {
    const contract = captureLegacySourceContract({ legacyRoot, manifest: m });
    const worker = fs.readFileSync(legacyRoot + '/scripts/process-image-studio.ts', 'utf8');
    for (const text of ["process.on('SIGTERM', () => { stopping = true; });", 'await Promise.all([processStudioTask(), processStudioTask()]);',
      'await billingWork;', 'await readinessWork;', '} while (!stopping);'])
      assert.ok(worker.includes(text), 'Original complete-Promise shutdown contract changed');
    return { ...contract, workerSha256: sha(worker) };
  });
}
const PROJECT = '/data/video-api-debugger';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const call = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 10000,
  env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, ...options }).trim();
function rootOnly() { assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0); }
function run(value) { assert.match(value, /^[a-f0-9-]{36}$/); return value; }
function inside(file) { assert.ok(path.isAbsolute(file) && file.startsWith(PROJECT + '/')); return file; }
function fsyncDirectory(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
export function fileIdentity(file, follow = false) {
  const stat = follow ? fs.statSync(file) : fs.lstatSync(file);
  return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777,
    kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special' };
}
export function ensureMaintenanceRunDirectory(runId) {
  rootOnly(); run(runId);
  const mount = call('findmnt', ['-n', '-o', 'TARGET', '-T', PROJECT]);
  assert.ok(mount === '/data' || mount.startsWith('/data/'));
  const directories = [path.join(PROJECT, 'entry-maintenance'), path.join(PROJECT, 'entry-maintenance', runId)];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o755 });
    assert.equal(fs.realpathSync(directory), directory);
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o022) && (stat.mode & 0o111) === 0o111,
      'Maintenance paths must be traversable but not writable by application/nginx users');
  }
  return directories.at(-1);
}

// Linux exchange preserves the original symlink inode, raw target and ownership.
// Each caller performs identity checks before and after the one atomic exchange.
export function exchangeOwnedPaths(left, right) {
  rootOnly(); assert.equal(path.dirname(left), path.dirname(right));
  const program = 'import ctypes,os,sys\nlibc=ctypes.CDLL(None,use_errno=True)\nf=libc.renameat2\nf.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nr=f(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),2)\nif r: raise OSError(ctypes.get_errno(),os.strerror(ctypes.get_errno()))\n';
  call('python3', ['-c', program, left, right]); fsyncDirectory(path.dirname(left));
}
function protectedFile(file) {
  const identity = fileIdentity(file); assert.equal(identity.kind, 'file'); assert.equal(identity.uid, 0);
  return { file, identity, sha256: sha(fs.readFileSync(file)), attributes: call('lsattr', ['-d', '--', file]).split(/\s+/)[0] };
}
function assertProtected(files) { for (const expected of files) assert.deepEqual(protectedFile(expected.file), expected); }
function inventory(root) {
  return fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name), realpath = fs.realpathSync(file);
    assert.ok(realpath.startsWith(PROJECT + '/'), `Storage leaf escaped project data: ${name}`);
    const identity = fileIdentity(realpath, true); assert.notEqual(identity.kind, 'special');
    return { name, realpath, identity };
  });
}

export function captureLegacyStorageAliases({ aliases, source = LEGACY_SOURCE }) {
  rootOnly(); assert.equal(source, LEGACY_SOURCE); assert.ok(Array.isArray(aliases) && aliases.length > 0);
  const byPhysicalAlias = new Map();
  for (const entry of aliases) {
    assert.ok(['web', 'image'].includes(entry.role)); inside(entry.root);
    const root = fs.realpathSync(entry.root);
    assert.equal(fs.readFileSync(path.join(root, '.deployed-commit'), 'utf8').trim(), source);
    const alias = path.join(root, 'storage'), identity = fileIdentity(alias);
    assert.equal(identity.kind, 'symlink', 'Only the exact old storage alias may be exchanged');
    const captured = byPhysicalAlias.get(alias);
    if (captured) { captured.roles.push(entry.role); continue; }
    const rawTarget = fs.readlinkSync(alias), realRoot = fs.realpathSync(alias);
    const leaves = inventory(realRoot);
    const marker = protectedFile(path.join(realRoot, 'image-studio-drain'));
    assert.equal(marker.identity.mode, 0o444); assert.ok(marker.attributes.includes('i'));
    const markerBody = JSON.parse(fs.readFileSync(marker.file, 'utf8'));
    assert.equal(markerBody.schema, 'pricing-writer-isolation.v1'); assert.equal(markerBody.protocol, 'pricing-policy-v1');
    const controls = ['allowed.json', 'writer-start-guard.mjs'].map(name => protectedFile(path.join(PROJECT, 'controls/pricing-writer-v1', name)));
    byPhysicalAlias.set(alias, { alias, roles: [entry.role], identity, rawTarget, realRoot,
      physicalRoot: fileIdentity(realRoot, true), leaves, protectedFiles: [marker, ...controls] });
  }
  assert.ok(aliases.some(entry => entry.role === 'web') && aliases.some(entry => entry.role === 'image'));
  return { schema: 'rate-impl2-legacy-storage-capture.v1', source, capturedAt: Date.now(), aliases: [...byPhysicalAlias.values()] };
}

