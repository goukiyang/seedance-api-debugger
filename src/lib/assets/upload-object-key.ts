import { createHash } from 'node:crypto';

// Legacy keys have no owner segment; callers must first verify the DB owner.
export function configuredUploadObjectKey(original: string, ownerId: string, publicBase: string | undefined): string | null {
  if (!publicBase || /[\s\\%?#]/.test(original)) return null;
  try {
    const base = new URL(publicBase.replace(/\/+$/, ''));
    const url = new URL(original);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || url.origin !== base.origin || url.username || url.password || url.search || url.hash) return null;
    const prefix = base.href.replace(/\/+$/, '') + '/';
    if (!original.startsWith(prefix) || url.href !== original) return null;
    const key = original.slice(prefix.length);
    if (key.split('/').some(part => !part || part === '.' || part === '..')) return null;
    const digest = createHash('sha256').update(ownerId).digest('hex').slice(0, 16);
    if (key.startsWith(`seedance-direct-uploads/${digest}/`)) return key;
    return /^seedance-uploads\/[a-f0-9]{8}-\d{10,16}\.[a-z0-9]{1,8}$/.test(key) ? key : null;
  } catch { return null; }
}
