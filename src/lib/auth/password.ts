import crypto from 'crypto';

const SALT_LEN = 32;
const KEY_LEN = 64;
const N = 2 ** 14;
const R = 8;
const P = 1;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const derived = crypto.scryptSync(password, salt, KEY_LEN, {
    N,
    r: R,
    p: P,
    maxmem: 128 * 1024 * 1024,
  });
  const hash = derived.toString('base64');
  return `scrypt:${salt.toString('base64')}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const targetHash = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(password, salt, KEY_LEN, {
      N,
      r: R,
      p: P,
      maxmem: 128 * 1024 * 1024,
    });
    if (derived.length !== targetHash.length) return false;
    return crypto.timingSafeEqual(derived, targetHash);
  } catch {
    return false;
  }
}
