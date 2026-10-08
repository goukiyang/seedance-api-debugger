import crypto from 'crypto';
import { hasInternalEmailAuthorization, type AccountScopedUser } from '@/lib/access/external-role';

type SessionAccount = AccountScopedUser & { id: string; password_hash: string };

// Preserve legacy sessions for every other account. Explicit internal-email
// sessions are bound to the current password hash so restored old cookies and
// sessions issued before a subsequent password reset cannot regain access.
export function sessionAccountPayload(user: SessionAccount) {
  return hasInternalEmailAuthorization(user)
    ? `${user.id}:${crypto.createHash('sha256').update(user.password_hash).digest('hex')}`
    : user.id;
}

export function sessionAccountPayloadMatches(payload: string, user: SessionAccount) {
  const actual = Buffer.from(payload);
  const expected = Buffer.from(sessionAccountPayload(user));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
