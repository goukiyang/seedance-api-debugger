export type SecretPurpose = 'session' | 'upload' | 'feishuState' | 'registration' | 'pricing' | 'media' | 'videoCallback' | 'privateIdentity' | 'errorLog' | 'rateLimit';
const secrets: {
  requireSecret(purpose: SecretPurpose): Buffer;
  assertStartupSecrets(): Record<SecretPurpose, true>;
  requireLegacySessionSecret(): string;
  validSecret(value: unknown): boolean;
} = require('./secrets.cjs');

export const { requireSecret, assertStartupSecrets, requireLegacySessionSecret, validSecret } = secrets;
