'use strict';
const { hkdfSync } = require('node:crypto');

const secretEnvironment = Object.freeze({
  session: 'SESSION_DIGEST_SECRET',
  upload: 'UPLOAD_TICKET_SECRET',
  feishuState: 'FEISHU_STATE_SECRET',
  registration: 'REGISTRATION_SECRET',
  pricing: 'PRICING_SIGNATURE_SECRET',
  media: 'MEDIA_SIGNATURE_SECRET',
  videoCallback: 'VIDEO_DELIVERY_CALLBACK_SECRET',
  privateIdentity: 'PRIVATE_IDENTITY_SECRET',
  errorLog: 'ERROR_LOG_SECRET',
  rateLimit: 'RATE_LIMIT_SECRET',
});
const knownDefaults = new Set(['dev-secret-change-in-production', 'change-me', 'your-secret-key']);

function validSecret(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 32
    && value.trim().length > 0 && !knownDefaults.has(value.trim());
}
function invalid(purpose) {
  const error = new Error(`SECRET_CONFIGURATION_INVALID:${purpose}`);
  error.code = 'SECRET_CONFIGURATION_INVALID';
  throw error;
}
function requireSecret(purpose) {
  if (!Object.hasOwn(secretEnvironment, purpose)) return invalid('unknown-purpose');
  const configured = process.env[secretEnvironment[purpose]];
  // An explicitly configured but invalid key must not silently fall back.
  if (configured !== undefined) {
    if (!validSecret(configured)) return invalid(purpose);
    return Buffer.from(configured, 'utf8');
  }
  const master = process.env.SESSION_SECRET;
  if (!validSecret(master)) return invalid(purpose);
  return Buffer.from(hkdfSync('sha256', master, 'sd2-signing-keys.v1', purpose, 32));
}
function assertStartupSecrets() {
  for (const purpose of Object.keys(secretEnvironment)) requireSecret(purpose);
  return Object.fromEntries(Object.keys(secretEnvironment).map(purpose => [purpose, true]));
}

// Only verification/migration of already-issued v1 receipts may use the old key.
// New protocols must use a purpose-separated key from requireSecret.
function requireLegacySessionSecret() {
  const value = process.env.SESSION_SECRET;
  if (!validSecret(value)) return invalid('legacy-session');
  return value;
}
module.exports = { requireSecret, assertStartupSecrets, requireLegacySessionSecret, validSecret };
