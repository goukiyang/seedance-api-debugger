import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// The configured root is trusted; every existing ancestor below it must remain inside it.
export function resolveInsideSync(root: string, relative: string): string {
  if (!relative || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)
    || path.win32.isAbsolute(relative) || relative.split('/').some(part => part === '..')) throw new Error('INVALID_LOCAL_PATH');
  const base = realpathSync(root);
  let candidate = path.resolve(base, relative);
  if (!inside(base, candidate)) throw new Error('INVALID_LOCAL_PATH');
  const missing: string[] = [];
  while (true) {
    try {
      const actual = realpathSync(candidate);
      if (!inside(base, actual)) throw new Error('INVALID_LOCAL_PATH');
      return path.join(actual, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let symlink = false;
      try { symlink = lstatSync(candidate).isSymbolicLink(); } catch {}
      if (symlink) throw new Error('INVALID_LOCAL_PATH');
      missing.unshift(path.basename(candidate));
      const parent = path.dirname(candidate);
      if (parent === candidate || !inside(base, parent)) throw new Error('INVALID_LOCAL_PATH');
      candidate = parent;
    }
  }
}

export async function resolveInside(root: string, relative: string): Promise<string> {
  return resolveInsideSync(root, relative);
}
