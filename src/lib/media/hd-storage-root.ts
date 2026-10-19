import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const HD_CANONICAL_ROOT = '/data/video-api-debugger/var-lib/storage/hd-derivatives';
export const HD_UPLOAD_DIRECTORY_ACCESS = constants.R_OK | constants.X_OK;
export const HD_OUTPUT_DIRECTORY_ACCESS = constants.R_OK | constants.W_OK | constants.X_OK;

// This resolver is deliberately synchronous: every reader and writer, including
// Web requests, resolves the same directory before opening any manifest.
export function resolveHdDirectory(options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const env = options.env || process.env;
  const configured = env.HD_DERIVATIVES_ROOT;
  if (env.NODE_ENV === 'production') {
    if (configured !== HD_CANONICAL_ROOT) throw new Error('hd_storage_configuration');
    return HD_CANONICAL_ROOT;
  }
  if (configured !== undefined && (!path.isAbsolute(configured) || path.normalize(configured) !== configured)) throw new Error('hd_storage_configuration');
  return configured || path.join(options.cwd || process.cwd(), 'storage', 'hd-derivatives');
}
export const hdDirectory = () => resolveHdDirectory();
// The pre-existing flock is a sibling of hd-derivatives, never a second lock.
export const hdWorkerLockPath = () => path.join(path.dirname(hdDirectory()), 'hd-worker.lock');

export function hdDataMountRecorded(mountInfo: string) {
  return mountInfo.split('\n').some(line => {
    const fields = line.split(' ');
    return fields.length > 6 && fields[4] === '/data' && line.includes(' - ');
  });
}
export async function assertHdStorageRoot(access: typeof fs.access = fs.access) {
  const configured = hdDirectory();
  // Production must already have its durable directory. Never create a missing
  // /data lookalike or follow a release symlink as an automatic fallback.
  const root = await fs.realpath(configured);
  const info = await fs.stat(root);
  if (!info.isDirectory()) throw new Error('hd_storage_not_directory');
  const uid = process.getuid?.();
  if (process.env.NODE_ENV === 'production') {
    // The production HD root is private to the actual runtime user (0700), not
    // a group-trusted media directory. A root probe must run as that same user.
    if (uid === undefined || info.uid !== uid || (info.mode & 0o077)) throw new Error('hd_storage_owner');
  } else if ((info.mode & 0o002) || uid !== undefined && info.uid !== uid) throw new Error('hd_storage_owner');
  await access(root, HD_OUTPUT_DIRECTORY_ACCESS);
  const system = await fs.stat('/');
  if (process.env.NODE_ENV === 'production') {
    if (process.platform !== 'linux' || root !== HD_CANONICAL_ROOT) throw new Error('hd_storage_realpath');
    const data = await fs.realpath('/data');
    const mount = await fs.stat(data);
    if (data !== '/data' || !hdDataMountRecorded(await fs.readFile('/proc/self/mountinfo', 'utf8'))
      || mount.dev === system.dev || info.dev !== mount.dev) throw new Error('hd_storage_mount');
  }
  return { root, device: info.dev, inode: info.ino, uid: info.uid, gid: info.gid, separateDataMount: info.dev !== system.dev };
}
