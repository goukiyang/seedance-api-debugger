import { constants, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readlink, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMultiviewWorkConsumerLock } from './multiview-work-render';

export const MULTIVIEW_WORKS_RUNTIME_PROTOCOL = 'multiview.works.v1' as const;
export const MULTIVIEW_WORKS_RUNTIME_ROOT = '/data/video-api-debugger/var-lib/storage/multiview-works';
export const MULTIVIEW_WORKS_RUNTIME_SOURCES = Object.freeze([
  'scripts/process-multiview-works.ts',
  'src/lib/video/multiview-works-runtime.ts',
  'src/lib/video/multiview-work-render.ts',
  'src/lib/video/multiview-output-assets.server.ts',
  'src/lib/video/multiview-output-access.server.ts',
  'src/lib/video/multiview-recipe-storage.server.ts',
  'src/lib/video/multiview-works.ts',
  'src/lib/video/multiview-work-contract.ts',
  'src/lib/prisma.ts',
  'prisma/schema.prisma',
  'package.json',
  'ops/sd2-multiview-works-start.mjs',
]);
export type MultiviewWorksRuntimeState = 'active' | 'stopping' | 'stopped';
export type MultiviewWorksRuntimeRecord = {
  schema: typeof MULTIVIEW_WORKS_RUNTIME_PROTOCOL;
  protocol: typeof MULTIVIEW_WORKS_RUNTIME_PROTOCOL;
  state: MultiviewWorksRuntimeState;
  pid: number;
  parentPid: number;
  sourceRoot: string;
  source: string | null;
  version: string;
  build: string | null;
  startedAt: string;
  heartbeatAt: string;
  loadedModuleSha: Record<string, string>;
};
export type MultiviewWorksRuntime = {
  markStopping(): void;
  assertHealthy(): void;
  stop(): Promise<void>;
};
type Options = { lockPath: string; fixtureRoot?: string; onFailure: () => void };
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const unavailable = () => new Error('multiview_works_runtime_unavailable');
function requireRuntime(value: unknown): asserts value { if (!value) throw unavailable(); }
const missing = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
const descriptorPath = (directory: FileHandle, file: string) => `/proc/self/fd/${directory.fd}/${file}`;

/** Keep each traversed directory pinned; never follow a source or storage alias. */
async function directoryHandle(absolute: string) {
  requireRuntime(path.isAbsolute(absolute) && path.normalize(absolute) === absolute);
  let handle = await open('/', directoryFlags);
  try {
    for (const component of absolute.split('/').filter(Boolean)) {
      requireRuntime(component !== '.' && component !== '..');
      const next = await open(descriptorPath(handle, component), directoryFlags);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function sourceBytes(root: string, relative: string, maximum = 8 * 1024 * 1024, optional = false) {
  const parts = relative.split('/');
  requireRuntime(parts.every(part => part && part !== '.' && part !== '..'));
  let directory: FileHandle | null = null, handle: FileHandle | null = null;
  try {
    directory = await directoryHandle(path.join(root, ...parts.slice(0, -1)));
    handle = await open(descriptorPath(directory, parts[parts.length - 1]), readFlags);
    const before = await handle.stat();
    requireRuntime(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= maximum && !(before.mode & 0o022));
    const bytes = await handle.readFile();
    const after = await handle.stat();
    requireRuntime(bytes.length === before.size && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.nlink === 1);
    return bytes;
  } catch (error) { if (optional && missing(error)) return null; throw error; }
  finally { await handle?.close(); await directory?.close(); }
}

const sameIdentity = (before: Stats, after: Stats) => before.dev === after.dev && before.ino === after.ino
  && before.uid === after.uid && before.gid === after.gid && before.mode === after.mode && before.nlink === after.nlink
  && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;

/** Only the fixed root-owned managed build alias may cross a source path link. */
export async function readMultiviewWorksBuildId(root: string, optional = false): Promise<string | null> {
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  requireRuntime(uid !== null);
  const directory = await directoryHandle(root);
  let target: FileHandle | null = null, file: FileHandle | null = null;
  try {
    const rootInfo = await directory.stat();
    requireRuntime(rootInfo.uid === uid && !(rootInfo.mode & 0o022) && await realpath(root) === root);
    const aliasPath = descriptorPath(directory, '.next-prod');
    const aliasBefore = await lstat(aliasPath).catch(error => { if (optional && missing(error)) return null; throw error; });
    if (!aliasBefore) return null;
    const linked = aliasBefore.isSymbolicLink();
    requireRuntime(linked ? aliasBefore.uid === 0 && aliasBefore.nlink === 1
      && await readlink(aliasPath) === '.next-prod-candidate' : aliasBefore.isDirectory());
    const targetName = linked ? '.next-prod-candidate' : '.next-prod';
    const targetPath = path.join(root, targetName);
    target = await open(descriptorPath(directory, targetName), directoryFlags);
    const targetBefore = await target.stat();
    requireRuntime(targetBefore.isDirectory() && targetBefore.dev === rootInfo.dev
      && targetBefore.uid === uid && !(targetBefore.mode & 0o022));
    const assertBinding = async () => {
      const [rootNamed, aliasNamed, targetNamed, targetHeld] = await Promise.all([
        lstat(root), lstat(aliasPath), lstat(descriptorPath(directory, targetName)), target!.stat(),
      ]);
      requireRuntime(rootNamed.isDirectory() && !rootNamed.isSymbolicLink() && rootNamed.dev === rootInfo.dev
        && rootNamed.ino === rootInfo.ino && rootNamed.uid === uid && !(rootNamed.mode & 0o022)
        && await realpath(root) === root && sameIdentity(aliasBefore, aliasNamed)
        && targetNamed.isDirectory() && !targetNamed.isSymbolicLink()
        && sameIdentity(targetBefore, targetNamed) && sameIdentity(targetBefore, targetHeld)
        && await realpath(targetPath) === targetPath
        && await realpath(path.join(root, '.next-prod')) === targetPath);
      if (linked) requireRuntime(await readlink(aliasPath) === '.next-prod-candidate');
    };
    await assertBinding();
    file = await open(descriptorPath(target, 'BUILD_ID'), readFlags).catch(error => {
      if (optional && !linked && missing(error)) return null;
      throw error;
    });
    if (!file) { await assertBinding(); return null; }
    const before = await file.stat();
    requireRuntime(before.isFile() && before.nlink === 1 && before.uid === uid
      && !(before.mode & 0o022) && before.size > 0 && before.size <= 1024);
    const bytes = await file.readFile();
    requireRuntime(bytes.length === before.size && sameIdentity(before, await file.stat())
      && sameIdentity(before, await lstat(descriptorPath(target, 'BUILD_ID'))));
    await assertBinding();
    const build = bytes.toString('utf8').trim();
    requireRuntime(/^[A-Za-z0-9_-]{1,200}$/.test(build));
    return build;
  } finally { await file?.close(); await target?.close(); await directory.close(); }
}

async function startupIdentity(production: boolean) {
  const sourceRoot = await realpath(process.cwd());
  const ownFile = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
  requireRuntime(await realpath(ownFile) === path.join(sourceRoot, 'src/lib/video/multiview-works-runtime.ts'));
  if (production) requireRuntime(typeof process.argv[1] === 'string'
    && await realpath(path.resolve(process.argv[1])) === path.join(sourceRoot, 'scripts/process-multiview-works.ts'));
  const loadedModuleSha: Record<string, string> = {};
  for (const file of MULTIVIEW_WORKS_RUNTIME_SOURCES) {
    loadedModuleSha[file] = createHash('sha256').update((await sourceBytes(sourceRoot, file))!).digest('hex');
  }
  const packageInfo = JSON.parse((await sourceBytes(sourceRoot, 'package.json'))!.toString('utf8')) as { version?: unknown };
  requireRuntime(typeof packageInfo.version === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageInfo.version));
  const source = (await sourceBytes(sourceRoot, '.deployed-commit', 256, !production))?.toString('utf8').trim() || null;
  const build = await readMultiviewWorksBuildId(sourceRoot, !production);
  requireRuntime((!production && source === null || typeof source === 'string' && /^[a-f0-9]{40}$/.test(source))
    && (!production && build === null || typeof build === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(build)));
  if (production) requireRuntime(sourceRoot === `/data/video-api-debugger/managed-releases/${source}`);
  return { pid: process.pid, parentPid: process.ppid, sourceRoot, source, version: packageInfo.version,
    build, startedAt: new Date().toISOString(), loadedModuleSha };
}

async function runtimeDirectory(options: Options, production: boolean) {
  requireRuntime(process.platform === 'linux' && typeof process.geteuid === 'function');
  const root = production ? MULTIVIEW_WORKS_RUNTIME_ROOT : options.fixtureRoot;
  requireRuntime(typeof root === 'string' && path.isAbsolute(root) && path.normalize(root) === root && root !== '/');
  if (production) {
    requireRuntime(options.fixtureRoot === undefined && options.lockPath === path.join(path.dirname(root), 'multiview-works.lock'));
    const [data, system] = await Promise.all([lstat('/data'), stat('/')]);
    requireRuntime(data.isDirectory() && !data.isSymbolicLink() && data.dev !== system.dev && await realpath('/data') === '/data');
  } else {
    requireRuntime(root !== '/data/video-api-debugger' && !root.startsWith('/data/video-api-debugger/'));
  }
  const directory = await directoryHandle(root);
  try {
    const info = await directory.stat(), named = await lstat(root);
    requireRuntime(await realpath(root) === root && named.isDirectory() && !named.isSymbolicLink()
      && info.dev === named.dev && info.ino === named.ino && (info.mode & 0o777) === 0o700 && info.uid === process.geteuid());
    if (production) requireRuntime(info.dev === (await stat('/data')).dev);
    return { root, directory };
  } catch (error) { await directory.close(); throw error; }
}

async function assertRuntimeLock(lockPath: string, uid: number) {
  const parent = await directoryHandle(path.dirname(lockPath));
  let handle: FileHandle | null = null;
  try {
    handle = await open(descriptorPath(parent, path.basename(lockPath)), readFlags);
    const info = await handle.stat(), named = await lstat(lockPath);
    requireRuntime(info.isFile() && info.nlink === 1 && (info.mode & 0o777) === 0o600 && info.uid === uid
      && named.isFile() && !named.isSymbolicLink() && info.dev === named.dev && info.ino === named.ino);
    await assertMultiviewWorkConsumerLock(lockPath);
  } finally { await handle?.close(); await parent.close(); }
}

/** The real flock-owning child calls this before it can claim any work. */
export async function startMultiviewWorksRuntime(options: Options): Promise<MultiviewWorksRuntime> {
  const production = process.env.NODE_ENV === 'production';
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  requireRuntime(uid !== null);
  await assertRuntimeLock(options.lockPath, uid);
  const { root, directory } = await runtimeDirectory(options, production);
  let state: MultiviewWorksRuntimeState = 'active', failed = false;
  let writing: Promise<void> = Promise.resolve();
  let heartbeat: Promise<void> | null = null, stoppingWrite = false;
  let timer: ReturnType<typeof setInterval> | null = null, stopPromise: Promise<void> | null = null;
  const fail = () => {
    if (failed) return;
    failed = true;
    if (state !== 'stopped') state = 'stopping';
    try { options.onFailure(); } catch { /* Failure already prevents subsequent consumption. */ }
  };
  try {
    const startup = await startupIdentity(production);
    const publish = () => {
      // Queued heartbeats use the latest phase and cannot follow a published
      // stopping record with active. Every temporary name is unique.
      const next = writing.catch(() => {}).then(async () => {
        const temporary = `runtime.${process.pid}.${randomUUID()}.tmp`;
        let file: FileHandle | null = null;
        try {
          await assertRuntimeLock(options.lockPath, uid);
          const currentDirectory = await lstat(root), heldDirectory = await directory.stat();
          requireRuntime(currentDirectory.isDirectory() && !currentDirectory.isSymbolicLink()
            && currentDirectory.dev === heldDirectory.dev && currentDirectory.ino === heldDirectory.ino
            && (heldDirectory.mode & 0o777) === 0o700 && heldDirectory.uid === uid);
          const existing = await lstat(descriptorPath(directory, 'runtime.json')).catch(error => { if (missing(error)) return null; throw error; });
          requireRuntime(!existing || existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1
            && (existing.mode & 0o777) === 0o600 && existing.uid === uid);
          const payload: MultiviewWorksRuntimeRecord = { schema: MULTIVIEW_WORKS_RUNTIME_PROTOCOL,
            protocol: MULTIVIEW_WORKS_RUNTIME_PROTOCOL, ...startup, state, heartbeatAt: new Date().toISOString() };
          const bytes = Buffer.from(JSON.stringify(payload) + '\n');
          requireRuntime(bytes.length <= 64 * 1024);
          file = await open(descriptorPath(directory, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          await file.chmod(0o600);
          const before = await file.stat();
          requireRuntime(before.isFile() && before.nlink === 1 && before.uid === uid);
          await file.writeFile(bytes); await file.sync();
          const after = await file.stat();
          requireRuntime(before.dev === after.dev && before.ino === after.ino && after.size === bytes.length
            && after.nlink === 1 && (after.mode & 0o777) === 0o600);
          await file.close(); file = null;
          await rename(descriptorPath(directory, temporary), descriptorPath(directory, 'runtime.json'));
          await directory.sync();
        } finally {
          await file?.close();
          await unlink(descriptorPath(directory, temporary)).catch(error => { if (!missing(error)) throw error; });
        }
      });
      writing = next;
      return next.catch(error => { fail(); throw error; });
    };
    await publish();
    timer = setInterval(() => {
      if (heartbeat || failed || state === 'stopped') return;
      heartbeat = publish().catch(() => { /* fail() has already requested graceful shutdown. */ })
        .finally(() => { heartbeat = null; });
    }, 10000);
    return {
      markStopping() {
        if (state === 'stopped') return;
        state = 'stopping';
        if (!stoppingWrite && !failed) { stoppingWrite = true; void publish().catch(() => {}); }
      },
      assertHealthy() { if (failed) throw unavailable(); },
      stop() {
        if (stopPromise) return stopPromise;
        state = 'stopping';
        if (timer) { clearInterval(timer); timer = null; }
        stopPromise = (async () => {
          try {
            if (heartbeat) await heartbeat;
            await writing.catch(() => {});
            state = 'stopped';
            await publish();
            await writing;
            if (failed) throw unavailable();
          } finally { await directory.close(); }
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    if (timer) clearInterval(timer);
    await writing.catch(() => {});
    await directory.close();
    throw error;
  }
}
