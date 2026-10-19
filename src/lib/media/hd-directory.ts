import path from 'node:path';

export const CANONICAL_HD_DIRECTORY = '/data/video-api-debugger/var-lib/storage/hd-derivatives';

export function resolveHdDirectory({ root, env, mode }: {
  root: string;
  env: Readonly<{ HD_DERIVATIVES_ROOT?: unknown }>;
  mode?: string;
}): string {
  const configured = env.HD_DERIVATIVES_ROOT;
  if (configured === CANONICAL_HD_DIRECTORY) return CANONICAL_HD_DIRECTORY;
  if (configured !== undefined) {
    throw new Error('HD_DERIVATIVES_ROOT 配置无效：只能使用已确认的共享高清目录 ' + CANONICAL_HD_DIRECTORY);
  }
  if (mode === 'production') {
    throw new Error('HD_DERIVATIVES_ROOT 未配置：生产环境必须明确绑定共享高清目录 ' + CANONICAL_HD_DIRECTORY);
  }
  return path.join(root, 'storage', 'hd-derivatives');
}

// Server startup configuration is immutable for this module instance. No caller
// or HTTP input can replace it; isolated non-production fixtures keep their cwd.
const serverEnvironment = Object.freeze({ HD_DERIVATIVES_ROOT: process.env.HD_DERIVATIVES_ROOT });
const serverMode = process.env.NODE_ENV;
export const hdDirectory = () => resolveHdDirectory({ root: process.cwd(), env: serverEnvironment, mode: serverMode });
