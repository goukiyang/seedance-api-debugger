import 'server-only';

/** The preview is closed unless one exact existing account is configured on the server. */
export function canUseWorksPreview(user: { id: string; account_type?: string | null } | null | undefined) {
  const allowedUserId = process.env.WORKS_PREVIEW_USER_ID?.trim();
  return Boolean(allowedUserId && user?.id === allowedUserId && user.account_type === 'internal');
}
