import { isExternalUser, type AccountScopedUser } from '@/lib/access/external-role';

// The compatible recovery build keeps member entry closed while retaining the binding reader.
export const CUTOUT_MEMBERS_ENABLED = true;
export function canUseCutout(user: AccountScopedUser | null | undefined) {
  return Boolean(user?.account_type === 'internal' && !isExternalUser(user)
    && (CUTOUT_MEMBERS_ENABLED || user.role === 'admin'));
}
