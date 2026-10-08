import crypto from 'crypto';
import { hasInternalEmailAuthorization, type AccountScopedUser } from '@/lib/access/external-role';
import { hasSessionPasswordBinding } from './password';

export type SessionAccount = AccountScopedUser & {
  id: string;
  password_hash: string;
  user_profile?: string | null;
  status?: string;
  expires_at?: Date | null;
};

function accountState(user: SessionAccount) {
  return [user.role, user.account_type, user.feature_profile_id, user.user_profile,
    user.status, user.expires_at?.getTime() ?? null];
}

// Once granted, retain the marker even after authorization is withdrawn. Only
// these accounts leave the legacy format; other users keep their sessions.
export function maintainAccountSessionBinding(before: SessionAccount, after: SessionAccount, passwordHash = before.password_hash) {
  const tracked = hasSessionPasswordBinding(before.password_hash)
    || hasInternalEmailAuthorization(before) || hasInternalEmailAuthorization(after);
  if (!tracked) return passwordHash;
  if (hasSessionPasswordBinding(passwordHash) && passwordHash === before.password_hash
    && JSON.stringify(accountState(before)) === JSON.stringify(accountState(after))) return passwordHash;
  return `${passwordHash.split(':').slice(0, 3).join(':')}:session-v1-${crypto.randomBytes(16).toString('hex')}`;
}

export function sessionAccountPayload(user: SessionAccount, secret: string) {
  if (!hasSessionPasswordBinding(user.password_hash) && !hasInternalEmailAuthorization(user)) return user.id;
  const binding = crypto.createHmac('sha256', secret)
    .update(JSON.stringify(['account-session-v1', user.id, user.password_hash, accountState(user)])).digest('hex');
  return `${user.id}:${binding}`;
}

export function sessionAccountPayloadMatches(payload: string, user: SessionAccount, secret: string) {
  if (user.status && user.status !== 'active') return false;
  if (user.expires_at && user.expires_at.getTime() <= Date.now()) return false;
  const actual = Buffer.from(payload);
  const expected = Buffer.from(sessionAccountPayload(user, secret));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
