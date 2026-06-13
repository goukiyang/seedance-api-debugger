export const REGISTER_CHALLENGE_COOKIE = 'register_challenge';
export const REGISTER_CODE_TTL_SECONDS = 10 * 60;
export const MIN_REGISTER_PASSWORD_LENGTH = 8;

export function isRegisterEmailVerificationEnabled(): boolean {
  return process.env.REGISTER_EMAIL_VERIFICATION === 'true';
}

export function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeEmail(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

export function isValidRegisterEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function usernameBaseFromEmail(email: string): string {
  const localPart = email.split('@')[0] || 'user';
  const normalized = localPart
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return normalized || 'user';
}
