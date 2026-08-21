export type AccountScopedUser = {
  role?: string | null;
  account_type?: string | null;
};

export function isExternalUser(user: AccountScopedUser | null | undefined) {
  return user?.role !== 'admin' && user?.account_type === 'external';
}

export function externalFallbackPath() {
  return '/generate/ip';
}
