export const COMPANY_EMAIL_DOMAIN = '@youdoogo.com';
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

export function normalizeCompanyEmail(value: unknown): string {
  const input = normalizeEmail(value);
  if (!input) return '';
  if (input.includes('@')) return input;
  return `${input}${COMPANY_EMAIL_DOMAIN}`;
}

export function isCompanyEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.endsWith(COMPANY_EMAIL_DOMAIN);
}

export function usernameBaseFromEmail(email: string): string {
  const localPart = email.split('@')[0] || 'user';
  const normalized = localPart
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return normalized || 'user';
}
