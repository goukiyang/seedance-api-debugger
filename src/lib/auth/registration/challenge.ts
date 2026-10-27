import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireSecret } from '@/lib/security/secrets';

interface RegisterChallengePayload {
  email: string;
  name: string;
  passwordHash: string;
  codeHash: string;
  nonce: string;
  expiresAt: number;
}

function digest(token: string) { return crypto.createHash('sha256').update(token).digest('hex'); }
export function createRegisterCode() { return crypto.randomInt(100000, 1000000).toString(); }
export function createRegisterNonce() { return crypto.randomBytes(16).toString('base64url'); }
export function hashRegisterCode(email: string, nonce: string, code: string) {
  return crypto.createHmac('sha256', requireSecret('registration')).update(`${email}:${nonce}:${code}`).digest('base64url');
}

export async function createRegisterChallengeToken(payload: RegisterChallengePayload): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.registrationChallenge.create({ data: { token_digest: digest(token), email: payload.email, name: payload.name,
    password_hash: payload.passwordHash, code_hash: payload.codeHash, nonce: payload.nonce, expires_at: new Date(payload.expiresAt) } });
  return token;
}

export async function consumeRegisterChallenge(tx: Prisma.TransactionClient, token: string | undefined, email: string, code: string) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const token_digest = digest(token), now = new Date();
  const challenge = await tx.registrationChallenge.findUnique({ where: { token_digest } });
  if (!challenge || challenge.consumed_at || challenge.expires_at <= now || challenge.attempts >= 5) return null;
  const claimed = await tx.registrationChallenge.updateMany({ where: { token_digest, attempts: challenge.attempts,
    consumed_at: null, expires_at: { gt: now } }, data: { attempts: { increment: 1 } } });
  if (claimed.count !== 1) return null;
  const provided = Buffer.from(hashRegisterCode(challenge.email, challenge.nonce, code));
  const expected = Buffer.from(challenge.code_hash);
  const correct = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  if (!correct || challenge.email !== email) return null;
  await tx.registrationChallenge.update({ where: { token_digest }, data: { consumed_at: now } });
  return { email: challenge.email, name: challenge.name, passwordHash: challenge.password_hash };
}
