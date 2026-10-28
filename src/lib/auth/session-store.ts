import crypto from 'node:crypto';
import type { Prisma, User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireSecret } from '@/lib/security/secrets';
import { SessionUnavailableError } from './session-errors';

export const SESSION_IDLE_MS = 7 * 86400000;
export const SESSION_ABSOLUTE_MS = 30 * 86400000;
export type SessionAccount = Pick<User, 'id' | 'password_hash' | 'role' | 'account_type' | 'feature_profile_id' | 'user_profile' | 'status' | 'expires_at'>;
type StoreClient = Prisma.TransactionClient;
export type SessionClient = Pick<Prisma.TransactionClient, 'userSession'>;
export type SessionDevice = { userAgent?: string | null; ip?: string | null };
export function requestSessionDevice(request: { headers: Headers }): SessionDevice {
  return { userAgent: request.headers.get('user-agent')?.slice(0, 512), ip: request.headers.get('x-real-ip')?.slice(0, 64) };
}

export function sessionTokenDigest(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function accountSessionDigest(user: SessionAccount) {
  return crypto.createHmac('sha256', requireSecret('session')).update(JSON.stringify([
    user.id, user.password_hash, user.role, user.account_type, user.feature_profile_id,
    user.user_profile, user.status, user.expires_at?.getTime() ?? null,
  ])).digest('hex');
}

export function isUsableAccount(user: SessionAccount, now = new Date()) {
  return user.status === 'active' && ['admin', 'user'].includes(user.role)
    && ['internal', 'external'].includes(user.account_type)
    && (!user.expires_at || user.expires_at > now);
}

function deviceSummary(device?: SessionDevice) {
  const browser = /Firefox/i.test(device?.userAgent || '') ? 'Firefox'
    : /Edg\//i.test(device?.userAgent || '') ? 'Edge'
    : /Chrome/i.test(device?.userAgent || '') ? 'Chrome'
    : /Safari/i.test(device?.userAgent || '') ? 'Safari' : null;
  const ip = device?.ip?.trim() || '';
  const ip_prefix = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? `${ip.split('.').slice(0, 3).join('.')}.0/24`
    : /^[a-f\d:]+$/i.test(ip) && ip.includes(':') ? `${ip.split(':').slice(0, 3).join(':')}::/48` : null;
  return { browser, ip_prefix };
}

export async function createSession(userId: string, expected?: SessionAccount, tx?: StoreClient, device?: SessionDevice): Promise<string> {
  const create = async (client: StoreClient) => {
    const user = await client.user.findUnique({ where: { id: userId } });
    const now = new Date();
    if (!user || !isUsableAccount(user, now) || (expected && accountSessionDigest(user) !== accountSessionDigest(expected))) {
      throw new Error('Account changed during authentication');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await client.userSession.create({ data: {
      token_digest: sessionTokenDigest(token), user_id: user.id, account_digest: accountSessionDigest(user),
      created_at: now, last_activity_at: now, expires_at: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
      ...deviceSummary(device),
    } });
    return token;
  };
  return tx ? create(tx) : prisma.$transaction(create);
}

export async function resolveSession(token?: string | null, client: SessionClient = prisma): Promise<User | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const digest = sessionTokenDigest(token);
    const row = await client.userSession.findUnique({ where: { token_digest: digest }, include: { user: true } });
    const now = new Date(), idleCutoff = new Date(now.getTime() - SESSION_IDLE_MS);
    if (!row || row.revoked_at || row.expires_at <= now || row.last_activity_at <= idleCutoff
      || row.created_at.getTime() + SESSION_ABSOLUTE_MS <= now.getTime()
      || !isUsableAccount(row.user, now) || row.account_digest !== accountSessionDigest(row.user)) return null;
    const touched = await client.userSession.updateMany({
      where: { token_digest: digest, revoked_at: null, expires_at: { gt: now }, last_activity_at: { gt: idleCutoff },
        user: { is: { id: row.user.id, password_hash: row.user.password_hash, role: row.user.role,
          account_type: row.user.account_type, feature_profile_id: row.user.feature_profile_id,
          user_profile: row.user.user_profile, status: row.user.status, expires_at: row.user.expires_at } } },
      data: { last_activity_at: now },
    });
    return touched.count === 1 ? row.user : null;
  } catch {
    throw new SessionUnavailableError();
  }
}

export async function revokeSession(token: string, reason = 'logout', tx: StoreClient = prisma) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  await tx.userSession.updateMany({ where: { token_digest: sessionTokenDigest(token), revoked_at: null },
    data: { revoked_at: new Date(), revoke_reason: reason.slice(0, 100) } });
}

export async function revokeAllSessions(userId: string, reason: string, tx: StoreClient = prisma) {
  await tx.userSession.updateMany({ where: { user_id: userId, revoked_at: null },
    data: { revoked_at: new Date(), revoke_reason: reason.slice(0, 100) } });
}
