import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync,
  realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type AdmissionFault = 'legacy-evidence-key' | 'legacy-preopen-schema' | 'stale-preopen' | 'maintenance-status'
  | 'run' | 'source' | 'build' | 'pid' | 'cgroup' | 'publication-flag' | 'heartbeat-stale'
  | 'works-run' | 'works-manifest' | 'works-source' | 'works-build' | 'works-cgroup' | 'works-parent' | 'works-runtime-schema'
  | 'works-module-sha' | 'startup-content' | 'startup-identity' | 'source-dropin-content' | 'pricing-snapshot-type'
  | 'pricing-snapshot-key' | 'observer';

function evidenceBytesAt(filename: string, bytes: Buffer, mode = 0o600) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  writeFileSync(filename, bytes, { mode });
  const stat = statSync(filename);
  return { bytes, pointer: { path: filename, sha256: createHash('sha256').update(bytes).digest('hex'),
    identity: { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777,
      nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } } };
}
function evidenceAt(filename: string, value: unknown, mode = 0o600) {
  return evidenceBytesAt(filename, Buffer.from(JSON.stringify(value) + '\n'), mode);
}
function evidenceFile(directory: string, name: string, value: unknown, mode = 0o600) {
  return evidenceAt(path.join(directory, name), value, mode);
}

async function verifySyntheticAdmissions(privateDirectory: string) {
  const { validateMultiviewPrivateRecipeAdmissionFixture, validateMultiviewPrivateWorksProcessFixture } =
    await import('./install-multiview-private-recipe');
  const { observeMultiviewWorksStart, MULTIVIEW_WORKS_START_FILE } = await import('../ops/sd2-multiview-works-start.mjs');
  const root = path.join(privateDirectory, 'admission-fixtures'); mkdirSync(root, { mode: 0o700 });
  const now = Date.now(), runId = '00000000-0000-4000-8000-000000000731', manifestSha256 = 'a'.repeat(64);
  const mainSource = '1'.repeat(40), guardSource = '2'.repeat(40), oldSource = '3'.repeat(40);
  const mainBuild = 'fixture-main-build', guardBuild = 'fixture-guard-build';
  const oldWebCgroup = '/system.slice/sd2-fixture-old.service', activeWebCgroup = '/system.slice/sd2-fixture-new.service';
  const oldPid = 91001, webPid = 92001, worksParentPid = 93001, worksPid = 93002, appUid = 1004;
  const requiredSources = ['ops/sd2-multiview-works-start.mjs', 'scripts/process-multiview-works.ts',
    'src/lib/video/multiview-work-render.ts', 'src/lib/video/multiview-output-assets.server.ts',
    'src/lib/video/multiview-output-access.server.ts', 'src/lib/video/multiview-recipe-storage.server.ts',
    'src/lib/video/multiview-works.ts', 'src/lib/video/multiview-works-runtime.ts',
    'src/lib/video/multiview-work-contract.ts', 'src/lib/prisma.ts'];
  const moduleBytes = readFileSync(path.join(realpathSync(process.cwd()), 'ops/sd2-multiview-works-start.mjs'));
  const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const make = async (name: string, fault?: AdmissionFault) => {
    const directory = path.join(root, name); mkdirSync(directory, { mode: 0o700 });
    const virtualRoot = path.join(directory, 'virtual'); mkdirSync(virtualRoot, { mode: 0o700 });
    const local = (virtual: string) => {
      assert.ok(virtual.startsWith('/'));
      return path.join(virtualRoot, virtual.slice(1));
    };
    const writeVirtual = (virtual: string, bytes: string | Buffer, mode = 0o644) => {
      const filename = local(virtual); mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      writeFileSync(filename, bytes, { mode });
    };
    const release = (source: string, version: string, build: string, label: string) => {
      const releaseRoot = `/data/video-api-debugger/managed-releases/${source}`;
      writeVirtual(`${releaseRoot}/.deployed-commit`, `${source}\n`);
      writeVirtual(`${releaseRoot}/package.json`, JSON.stringify({ name: `fixture-${label}`, version }));
      writeVirtual(`${releaseRoot}/.next-prod-candidate/BUILD_ID`, `${build}\n`);
      symlinkSync('.next-prod-candidate', local(`${releaseRoot}/.next-prod`));
      const sourceSha256: Record<string, string> = {};
      for (const file of requiredSources) {
        const bytes = file === 'ops/sd2-multiview-works-start.mjs' ? moduleBytes : Buffer.from(`fixture ${label} ${file}\n`);
        writeVirtual(`${releaseRoot}/${file}`, bytes); sourceSha256[file] = digest(bytes);
      }
      return { root: releaseRoot, source, version, build, sourceSha256 };
    };
    const main = release(mainSource, '0.103.0', mainBuild, 'main');
    const guard = release(guardSource, '0.102.1+guard.1', guardBuild, 'guard');
    const worksAllowedValue = { schema: 'sd2-multiview-works-start.v1', runId, manifestSha256, appUid,
      releases: [main, guard] };
    const worksAllowed = evidenceAt(local(MULTIVIEW_WORKS_START_FILE), worksAllowedValue, 0o644);
    const pricingAllowedValue = { schema: 'pricing-writer-start-allowlist.v1', project: 'video-api-debugger', runId,
      serviceUid: appUid, at: new Date(now - 2_000).toISOString(), marker: '/data/video-api-debugger/controls/fixture-marker',
      releases: [
        { root: main.root, source: mainSource, version: main.version, build: mainBuild,
          sourceFiles: { 'package.json': 'b'.repeat(64) }, buildFiles: { 'BUILD_ID': 'c'.repeat(64) } },
        { root: guard.root, source: guardSource, version: guard.version, build: guardBuild,
          sourceFiles: { 'package.json': 'd'.repeat(64) }, buildFiles: { 'BUILD_ID': 'e'.repeat(64) } },
      ] };
    const pricingAllowed = evidenceFile(directory, 'pricing-allowed.json', pricingAllowedValue, 0o644);
    const sourceDropinBytes = fault === 'source-dropin-content' ? Buffer.from('[Service]\nExecStartPre=/usr/bin/false\n')
      : Buffer.from(`[Service]\nWorkingDirectory=${main.root}\nExecStart=\n`
        + 'ExecStart=/usr/bin/node --import tsx scripts/process-multiview-works.ts\n'
        + 'ExecStartPre=/usr/bin/node /data/video-api-debugger/controls/multiview-works-v1/start.mjs\n');
    const sourceDropin = evidenceBytesAt(path.join(directory, '50-source.conf'), sourceDropinBytes, 0o644);
    let modulePointer = evidenceBytesAt(local('/data/video-api-debugger/controls/multiview-works-v1/start.mjs'), moduleBytes, 0o644).pointer;
    if (fault === 'startup-content') modulePointer = evidenceBytesAt(
      local('/data/video-api-debugger/controls/multiview-works-v1/start.mjs'), Buffer.from('different verifier\n'), 0o644).pointer;
    const preOpenValue = { schema: 'multiview-private-preopen.v1', mode: 'switch', kind: 'main', stage: 'private-preopen',
      runId, manifestSha256,
      healthy: { kind: 'main', source: mainSource, build: mainBuild, actualHealthy: true },
      web: { root: `/data/video-api-debugger/managed-releases/${mainSource}`, source: mainSource,
        build: mainBuild, pid: webPid, state: { ControlGroup: activeWebCgroup } },
      maintenance: [
        { host: 'sd2.youdooart.com', status: 503, checkedAt: now - 1_500, responseSha256: '4'.repeat(64) },
        { host: 'sd2-server.youdoodesign.com', status: 503, checkedAt: now - 1_500, responseSha256: '5'.repeat(64) },
      ], at: new Date(now - 1_000).toISOString() };
    const stopValue = { runId, manifestSha256, forcedKill: false, originalCgroup: oldWebCgroup,
      before: { MainPID: String(oldPid), ControlPID: '0', WorkingDirectory: `/data/video-api-debugger/managed-releases/${oldSource}`,
        ControlGroup: oldWebCgroup },
      after: { Result: 'success', ActiveState: 'inactive', MainPID: '0', ControlPID: '0' } };
    const worksReadyValue = { schema: 'multiview-works-ready.v1', runId, manifestSha256, kind: 'main', source: mainSource,
      version: main.version, build: mainBuild, unit: 'sd2-multiview-works.service',
      current: { MainPID: String(worksParentPid), ControlPID: '0', ControlGroup: '/system.slice/sd2-multiview-works.service',
        InvocationID: '6'.repeat(32), WorkingDirectory: main.root, ActiveState: 'active', SubState: 'running' },
      oldPids: [91011, 91012], oldCgroup: '/system.slice/sd2-multiview-works-old.service', naturalExit: true,
      runtime: { schema: 'multiview.works.v1', protocol: 'multiview.works.v1', state: 'active', pid: worksPid, parentPid: worksParentPid,
        sourceRoot: main.root, source: mainSource, version: main.version, build: mainBuild,
        startedAt: new Date(now - 60_000).toISOString(), heartbeatAt: new Date(now - 1_000).toISOString(),
        loadedModuleSha: { ...main.sourceSha256 } },
      startup: { allowed: worksAllowed.pointer, module: modulePointer, sourceDropin: sourceDropin.pointer },
      at: new Date(now - 500).toISOString() };
    const publishedValue = { runId, manifestSha256, published: { schema: 'pricing-start-pair-published.v1', runId,
      manifestSha256, actualExecStartPreVerified: false,
      stoppedWriters: {
        'sd2-gray.service': { MainPID: '0', ControlPID: '0', ActiveState: 'inactive' },
        'sd2-image-studio.service': { MainPID: '0', ControlPID: '0', ActiveState: 'inactive' },
      },
      installed: { path: pricingAllowed.pointer.path, ...pricingAllowed.pointer.identity, attributes: '----------------------',
        sha256: pricingAllowed.pointer.sha256, bytesBase64: pricingAllowed.bytes.toString('base64') } } };
    if (fault === 'legacy-preopen-schema') preOpenValue.schema = 'rate-impl2-switch-complete.v1';
    if (fault === 'stale-preopen') {
      preOpenValue.at = new Date(now - 91_000).toISOString();
      preOpenValue.maintenance.forEach(row => { row.checkedAt = now - 91_500; });
    }
    if (fault === 'maintenance-status') preOpenValue.maintenance[0].status = 200;
    if (fault === 'run') preOpenValue.runId = 'different-fixture-run';
    if (fault === 'source') preOpenValue.healthy.source = guardSource;
    if (fault === 'build') preOpenValue.web.build = 'different-build';
    if (fault === 'pid') preOpenValue.web.pid = 1;
    if (fault === 'cgroup') stopValue.before.ControlGroup = '/system.slice/different-old.service';
    if (fault === 'publication-flag') publishedValue.published.actualExecStartPreVerified = true;
    if (fault === 'heartbeat-stale') worksReadyValue.runtime.heartbeatAt = new Date(now - 46_000).toISOString();
    if (fault === 'works-run') worksReadyValue.runId = 'different-fixture-run';
    if (fault === 'works-manifest') worksReadyValue.manifestSha256 = '9'.repeat(64);
    if (fault === 'works-source') worksReadyValue.source = guardSource;
    if (fault === 'works-build') worksReadyValue.build = guardBuild;
    if (fault === 'works-cgroup') worksReadyValue.current.ControlGroup = '/../escaped';
    if (fault === 'works-parent') worksReadyValue.runtime.parentPid = worksParentPid + 1;
    if (fault === 'works-runtime-schema') worksReadyValue.runtime.schema = 'multiview.works.legacy';
    if (fault === 'works-module-sha') worksReadyValue.runtime.loadedModuleSha['scripts/process-multiview-works.ts'] = '9'.repeat(64);
    if (fault === 'startup-identity') worksReadyValue.startup.module.identity.ino += 1;
    if (fault === 'pricing-snapshot-type') (publishedValue.published.installed as Record<string, unknown>).dev =
      String(pricingAllowed.pointer.identity.dev);
    if (fault === 'pricing-snapshot-key') {
      const installed = publishedValue.published.installed as Record<string, unknown>;
      installed.file = installed.path; delete installed.path;
    }
    const preOpenEvidence = evidenceFile(directory, 'pre-open.json', preOpenValue);
    const worksReadyEvidence = evidenceFile(directory, 'works-ready.json', worksReadyValue);
    const stopEvidence = evidenceFile(directory, 'natural-stop-web.json', stopValue);
    const publicationEvidence = evidenceFile(directory, 'pricing-pair-published.json', publishedValue);
    const admission: Record<string, unknown> = { schema: 'multiview-private-recipe-admission.v1', runId, mainSource, mainBuild, guardSource, guardBuild,
      oldWebPids: [oldPid], oldWebCgroup, oldWebCgroupPids: [oldPid], additionalReaderPids: [],
      evidence: { preOpen: preOpenEvidence.pointer, worksReady: worksReadyEvidence.pointer, allowed: worksAllowed.pointer,
        naturalStopWeb: stopEvidence.pointer, pricingPairPublished: publicationEvidence.pointer } };
    if (fault === 'legacy-evidence-key') {
      const evidence = admission.evidence as Record<string, unknown>;
      evidence.switchComplete = evidence.preOpen; delete evidence.preOpen;
    }
    const shape = (stat: NonNullable<ReturnType<typeof lstatSync>>, virtual: string) => ({
      type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
      nlink: stat.nlink, uid: virtual === MULTIVIEW_WORKS_START_FILE
        || virtual.endsWith('/.next-prod') && stat.isSymbolicLink() ? 0 : appUid,
      mode: stat.mode, dev: virtual === '/' ? 11 : 22, ino: stat.ino, size: stat.size,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    });
    const adapter = (cwd: string, uid: number) => ({
      platform: 'linux', nodeVersion: '22.11.0', uid: () => uid, cwd: () => cwd,
      realpath: (virtual: string) => {
        const actual = realpathSync(local(virtual)), relative = path.relative(realpathSync(virtualRoot), actual);
        assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`));
        return relative ? '/' + relative.split(path.sep).join('/') : '/';
      },
      lstat: (virtual: string) => shape(lstatSync(local(virtual)), virtual),
      stat: (virtual: string) => shape(statSync(local(virtual)), virtual),
      readlink: (virtual: string) => readlinkSync(local(virtual)),
      readStableFile: (virtual: string) => {
        const descriptor = openSync(local(virtual), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = shape(fstatSync(descriptor), virtual), bytes = readFileSync(descriptor);
          const after = shape(fstatSync(descriptor), virtual);
          return { bytes, before, after };
        } finally { closeSync(descriptor); }
      },
      accessReadable: (virtual: string) => virtual === MULTIVIEW_WORKS_START_FILE
        && Boolean(lstatSync(local(virtual)).mode & 0o004),
    });
    const observer = (contract: Record<string, unknown>, context: { sourceRoot: string; appUid: number }) => fault === 'observer'
      ? { source: mainSource, build: mainBuild, actualUid: appUid, verified: false }
      : observeMultiviewWorksStart(contract, adapter(context.sourceRoot, context.appUid));
    return { directory, admission, observer };
  };
  const positive = await make('positive');
  assert.deepEqual(await validateMultiviewPrivateRecipeAdmissionFixture(positive.admission, positive.directory, positive.observer, now),
    { runId, mainSource, mainBuild, webPid, webCgroup: activeWebCgroup, worksPid });
  const faults: AdmissionFault[] = ['legacy-evidence-key', 'legacy-preopen-schema', 'stale-preopen', 'maintenance-status',
    'run', 'source', 'build', 'pid', 'cgroup', 'publication-flag', 'heartbeat-stale',
    'works-run', 'works-manifest', 'works-source', 'works-build', 'works-cgroup', 'works-parent', 'works-runtime-schema', 'works-module-sha',
    'startup-content', 'startup-identity', 'source-dropin-content', 'pricing-snapshot-type', 'pricing-snapshot-key', 'observer'];
  for (const fault of faults) {
    const negative = await make(`negative-${fault}`, fault);
    await assert.rejects(() => validateMultiviewPrivateRecipeAdmissionFixture(
      negative.admission, negative.directory, negative.observer, now));
  }
  const worksGroup = '/system.slice/sd2-multiview-works.service';
  const processInput = { mainPid: worksParentPid, runtimePid: worksPid, appUid,
    releaseRoot: `/data/video-api-debugger/managed-releases/${mainSource}`, worksGroup };
  const mainCommand = ['/usr/bin/node', '--import', 'tsx', 'scripts/process-multiview-works.ts'].join('\0') + '\0';
  const runtimeCommand = ['/usr/bin/node', '--import', 'tsx', `${processInput.releaseRoot}/scripts/process-multiview-works.ts`,
    '--multiview-worker-lock-held'].join('\0') + '\0';
  const helperPid = 93003;
  const helperCommand = [`${processInput.releaseRoot}/node_modules/@esbuild/linux-x64/bin/esbuild`,
    '--service=0.25.12', '--ping'].join('\0') + '\0';
  const processPositive = [
    { pid: worksParentPid, parentPid: 1, uid: appUid, cwd: processInput.releaseRoot, cgroup: worksGroup, command: mainCommand },
    { pid: worksPid, parentPid: worksParentPid, uid: appUid, cwd: processInput.releaseRoot, cgroup: worksGroup, command: runtimeCommand },
    { pid: helperPid, parentPid: worksPid, uid: appUid, cwd: processInput.releaseRoot, cgroup: worksGroup, command: helperCommand },
  ];
  assert.deepEqual(validateMultiviewPrivateWorksProcessFixture(processPositive, processInput),
    { pids: [worksParentPid, worksPid, helperPid] });
  const processFaults = ['missing-runtime', 'wrong-main-parent', 'main-extra-arg', 'main-empty-arg', 'runtime-missing-lock', 'outside-parent',
    'wrong-uid', 'wrong-root', 'wrong-command', 'foreign-helper', 'cycle'];
  for (const fault of processFaults) {
    const negative = structuredClone(processPositive);
    if (fault === 'missing-runtime') negative.splice(1, 1);
    if (fault === 'wrong-main-parent') negative[0].parentPid = 777;
    if (fault === 'main-extra-arg') negative[0].command = mainCommand.replace('scripts/process-multiview-works.ts\0',
      'scripts/process-multiview-works.ts\0--once\0');
    if (fault === 'main-empty-arg') negative[0].command = mainCommand.replace('--import\0tsx', '--import\0\0tsx');
    if (fault === 'runtime-missing-lock') negative[1].command = mainCommand;
    if (fault === 'outside-parent') negative[2].parentPid = 99999;
    if (fault === 'wrong-uid') negative[2].uid = appUid + 1;
    if (fault === 'wrong-root') negative[2].cwd = `/data/video-api-debugger/managed-releases/${guardSource}`;
    if (fault === 'wrong-command') negative[2].command = '/bin/sh\0-c\0sleep 10\0';
    if (fault === 'foreign-helper') negative[2].command = `/tmp/esbuild\0--service=0.25.12\0--ping\0`;
    if (fault === 'cycle') negative[2].parentPid = helperPid;
    assert.throws(() => validateMultiviewPrivateWorksProcessFixture(negative, processInput));
  }
  return { rejectedAdmissionFixtures: faults.length, rejectedProcessFixtures: processFaults.length };
}

/** Isolated deployment-tool fixture. It never accepts production paths, databases or media. */
async function main() {
  const project = realpathSync(process.cwd()), scratch = path.join(project, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'multiview-private-install-'));
  const database = path.join(directory, 'synthetic.db'), privateDirectory = path.join(directory, 'private');
  mkdirSync(privateDirectory, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: `file:${database}`, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
    NEXT_TELEMETRY_DISABLED: '1', PATH: process.env.PATH };
  for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  const schema = execFileSync(process.execPath, [path.join(project, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(project, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  writeFileSync(path.join(privateDirectory, 'schema.log'), schema, { mode: 0o600 });
  process.env.DATABASE_URL = env.DATABASE_URL; Reflect.set(process.env, 'NODE_ENV', 'test');
  const { PrismaClient } = await import('@prisma/client'); const db = new PrismaClient();
  const guide = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const guideSha = createHash('sha256').update(guide).digest('hex');
  const prompt = '隔离工程配方：只验证私有安装事务与文件边界 @图片1';
  const promptSha = createHash('sha256').update(prompt).digest('hex');
  const ownerId = 'private-install-admin', assetId = 'private-install-asset', referenceId = 'private-install-reference';
  try {
    await db.user.create({ data: { id: ownerId, name: 'Synthetic private installer', username: ownerId,
      email: 'private-installer@isolated.invalid', password_hash: 'not-a-login-password', role: 'admin', account_type: 'internal', status: 'active' } });
    await db.videoTask.create({ data: { id: 'private-source-task', provider: 'seedance', model: 'dreamina-seedance-2-5-260628',
      generation_mode: 'all_in_one_reference', prompt, final_prompt_snapshot: prompt, owner_user_id: ownerId, user_id: ownerId } });
    await db.asset.create({ data: { id: assetId, owner_id: ownerId, type: 'image', original_url: `/uploads/assets/${guideSha}.png`,
      thumbnail_url: `/uploads/thumbs/${guideSha}.png`, file_name: 'synthetic-guide.png', mime_type: 'image/png', width: 1, height: 1,
      file_size: guide.length, hash: guideSha, status: 'active' } });
    await db.referenceAlbum.create({ data: { id: 'private-install-album', owner_user_id: ownerId, name: 'Synthetic private album' } });
    await db.referenceImage.create({ data: { id: referenceId, album_id: 'private-install-album', owner_user_id: ownerId, asset_id: assetId,
      url: `https://sd2.youdooart.com/uploads/assets/${guideSha}.png`, thumbnail_url: `/uploads/thumbs/${guideSha}.png`, status: 'active' } });
    await db.referenceImage.create({ data: { id: 'private-install-old-alias', album_id: 'private-install-album', owner_user_id: ownerId, asset_id: assetId,
      url: `/uploads/legacy/${guideSha}.png`, status: 'deleted' } });
  } finally { await db.$disconnect(); }

  const payload = { sourceTaskId: 'private-source-task', expectedRevision: 0, mutationId: randomUUID(), fullprompt: prompt,
    defaults: { provider: 'seedance', generationMode: 'all_in_one_reference', model: 'dreamina-seedance-2-5-260628', ratio: '1:1', duration: 8,
      resolution: '480p', seed: -1, generateAudio: false, returnLastFrame: false, watermark: false },
    ref2binding: { assetId, referenceImageId: referenceId, ownerId, sha256: guideSha }, expectedPromptSHA: promptSha, guideSHA: guideSha };
  const payloadFile = path.join(privateDirectory, 'payload.json'), guideFile = path.join(privateDirectory, 'guide.png');
  const planFile = path.join(privateDirectory, 'plan.json'), verificationFile = path.join(privateDirectory, 'verification.json');
  const receiptFile = path.join(privateDirectory, 'apply-receipt.json'), fixtureRoot = path.join(directory, 'recipes');
  writeFileSync(payloadFile, JSON.stringify(payload), { mode: 0o600 }); writeFileSync(guideFile, guide, { mode: 0o600 });
  const { rejectedAdmissionFixtures, rejectedProcessFixtures } = await verifySyntheticAdmissions(privateDirectory);
  const installer = path.join(project, 'scripts/install-multiview-private-recipe.ts');
  const run = (phase: 'plan' | 'verify' | 'apply', more: string[]) => execFileSync(process.execPath,
    ['--import', 'tsx', installer, phase, '--non-production', '--fixture-root', fixtureRoot,
      '--payload-file', payloadFile, '--guide-file', guideFile, ...more], { cwd: project, env, encoding: 'utf8', timeout: 120000 }).trim();
  const outputs = [run('plan', ['--proof-file', planFile]),
    run('verify', ['--plan-file', planFile, '--proof-file', verificationFile]),
    run('apply', ['--plan-file', planFile, '--verification-file', verificationFile, '--receipt-file', receiptFile]),
    run('apply', ['--plan-file', planFile, '--verification-file', verificationFile, '--receipt-file', receiptFile])];

  const verifyDb = new PrismaClient();
  try {
    const settings = await verifyDb.platformSetting.findMany();
    assert.equal(settings.filter(row => row.key === 'multiview_rotation_preset_v1:current').length, 1);
    assert.equal(settings.filter(row => row.key === 'multiview_rotation_preset_v1:version:1.0.1').length, 1);
    assert.equal(settings.filter(row => row.key === 'multiview_output_registration_v1:activation').length, 1);
    const protection = settings.find(row => row.key === `multiview_private_media_access_v1:${guideSha}`); assert.ok(protection);
    const protectedValue = JSON.parse(protection.value_json);
    assert.ok(protectedValue.urls.includes(`/uploads/legacy/${guideSha}.png`));
    assert.equal(await verifyDb.operationLog.count(), 1);
    assert.deepEqual(JSON.parse(outputs[2]), JSON.parse(outputs[3]));
  } finally { await verifyDb.$disconnect(); }
  writeFileSync(path.join(privateDirectory, 'engineering-receipt.json'), JSON.stringify({ schema: 'multiview-private-install-engineering.v1',
    completed: true, synthetic: true, productionWrites: 0, providerCalls: 0, phases: outputs.map(value => JSON.parse(value).phase),
    rejectedAdmissionFixtures, rejectedProcessFixtures,
    checks: ['isolated_plan_verify_apply', 'idempotent_original_mutation', 'single_transaction_activation_and_durable_url_protection',
      'private_png_exact_hash_and_mode', 'fresh_preopen_maintenance_works_ready_and_dual_allowlist_admission',
      'actual_works_start_observer_with_synthetic_filesystem_only',
      'legacy_stale_preopen_and_pricing_rejections',
      'works_run_manifest_source_build_cgroup_parent_module_heartbeat_startup_and_observer_rejections',
      'bounded_node_tsx_esbuild_process_tree_positive_and_negative_isolation'] }, null, 2), { mode: 0o600 });
  console.log(`Multiview private installer engineering receipt: ${path.join(privateDirectory, 'engineering-receipt.json')}`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Private installer engineering fixture failed'); process.exitCode = 1; });
