import crypto from 'crypto';

interface RegisterChallengePayload {
  email: string;
  name: string;
  passwordHash: string;
  codeHash: string;
  nonce: string;
  expiresAt: number;
}

const SIGNING_SECRET = process.env.REGISTRATION_SECRET || process.env.SESSION_SECRET || 'dev-secret-change-in-production';

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signPayload(payload: string): string {
  return crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('base64url');
}

export function createRegisterCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export function createRegisterNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

export function hashRegisterCode(email: string, nonce: string, code: string): string {
  return crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`${email}:${nonce}:${code}`)
    .digest('base64url');
}

export function createRegisterChallengeToken(payload: RegisterChallengePayload): string {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${signPayload(encoded)}`;
}

export function verifyRegisterChallengeToken(token: string | undefined): RegisterChallengePayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  const expected = signPayload(encoded);
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(signature);
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(encoded)) as RegisterChallengePayload;
    if (
      !parsed.email ||
      !parsed.passwordHash ||
      !parsed.codeHash ||
      !parsed.nonce ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
