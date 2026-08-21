export type AccountScopedUser = {
  role?: string | null;
  account_type?: string | null;
};

export function isExternalUser(user: AccountScopedUser | null | undefined) {
  return user?.role !== 'admin' && user?.account_type === 'external';
}

export function defaultLandingForUser(user: AccountScopedUser | null | undefined) {
  return isExternalUser(user) ? '/generate/ip' : '/generate';
}

export function safeLandingForUser(
  value: string | null | undefined,
  user: AccountScopedUser | null | undefined,
) {
  const fallback = defaultLandingForUser(user);
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  if (isExternalUser(user) && !isExternalAllowedPath(value)) return fallback;
  return value;
}

export function isExternalAllowedPath(pathname: string) {
  return (
    pathname === '/generate/ip'
    || pathname.startsWith('/tasks')
    || pathname === '/account'
    || pathname === '/notifications'
    || pathname === '/login'
    || pathname === '/register'
  );
}
