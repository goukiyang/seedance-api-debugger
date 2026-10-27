import type { Prisma } from '@prisma/client';
import type { AccountScopedUser } from '@/lib/access/external-role';

export type DtoViewer = AccountScopedUser & { id: string };
export const userSummarySelect = { id: true, name: true, username: true, avatar_url: true, account_type: true } as const satisfies Prisma.UserSelect;
export type UserSummarySource = Partial<{ id: string; name: string | null; username: string | null; avatar_url: string | null;
  account_type: string | null; email: string | null; phone: string | null; role: string; status: string }>;

export function toUserSummary(user: UserSummarySource | null | undefined, viewer?: DtoViewer) {
  if (!user) return null;
  const result: UserSummarySource = {};
  for (const key of ['id', 'name', 'username', 'avatar_url', 'account_type', 'role', 'status'] as const) {
    const value = user[key];
    if (typeof value === 'string' || value === null) Object.assign(result, { [key]: value });
  }
  if (viewer && (viewer.role === 'admin' || viewer.id === user.id)) {
    for (const key of ['email', 'phone'] as const) if (typeof user[key] === 'string' || user[key] === null) result[key] = user[key];
  }
  return result;
}
