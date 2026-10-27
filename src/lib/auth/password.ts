import crypto from 'node:crypto';
import { SessionUnavailableError } from './session-errors';

const SALT_LEN = 32, KEY_LEN = 64;
const CONCURRENCY = 2, MAX_WAITING = 128;
const waiting: (() => void)[] = [];
let active = 0;

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (active >= CONCURRENCY) {
    if (waiting.length >= MAX_WAITING) throw new SessionUnavailableError();
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, KEY_LEN, { N: 2 ** 14, r: 8, p: 1, maxmem: 128 * 1024 * 1024 },
        (error, result) => error ? reject(error) : resolve(result));
    });
  } finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password) > 1024) throw new Error('密码过长');
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = await derive(password, salt);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored?: string | null): Promise<boolean> {
  const parts = stored?.split(':') || [];
  // Read old password envelopes without trusting their obsolete fourth field.
  // New writes contain only the KDF, salt, and derived password bytes.
  const salt = Buffer.from(parts[1] || '', 'base64');
  const target = Buffer.from(parts[2] || '', 'base64');
  const valid = (parts.length === 3 || parts.length === 4) && parts[0] === 'scrypt'
    && salt.length === SALT_LEN && target.length === KEY_LEN && Buffer.byteLength(password) <= 1024;
  const derived = await derive(Buffer.byteLength(password) <= 1024 ? password : 'invalid-password', valid ? salt : Buffer.alloc(SALT_LEN, 127));
  const equal = crypto.timingSafeEqual(derived, valid ? target : Buffer.alloc(KEY_LEN));
  return valid && equal;
}
