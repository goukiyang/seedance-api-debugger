export function confirmedSessionUser<T extends { id: string }>(value: unknown): T | null {
  if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, 'user')) {
    throw new Error('Unconfirmed session response');
  }
  const user: unknown = (value as { user: unknown }).user;
  if (user === null) return null;
  if (!user || typeof user !== 'object' || typeof (user as { id?: unknown }).id !== 'string' || !(user as { id: string }).id) {
    throw new Error('Unconfirmed session response');
  }
  return user as T;
}
