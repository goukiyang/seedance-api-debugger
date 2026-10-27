import { createHmac, timingSafeEqual } from 'node:crypto';
import { requireLegacySessionSecret, requireSecret, type SecretPurpose } from './secrets';

type Encoding = 'hex' | 'base64url';
export function signPurpose(purpose: SecretPurpose, payload: string, encoding: Encoding = 'base64url') {
  return `v2:${createHmac('sha256', requireSecret(purpose)).update(payload).digest(encoding)}`;
}

// Old durable receipts remain verifiable without rewriting their payload or ID.
// Legacy acceptance is explicit at each consumer, never a fallback for a v2 MAC.
export function verifyPurpose(purpose: SecretPurpose, payload: string, signature: string,
  options: { encoding?: Encoding; legacy?: boolean; trimLegacy?: boolean } = {}) {
  const encoding = options.encoding || 'base64url';
  let expected: string;
  if (signature.startsWith('v2:')) expected = signPurpose(purpose, payload, encoding);
  else {
    if (!options.legacy || signature.includes(':')) return false;
    let key = requireLegacySessionSecret();
    if (options.trimLegacy) key = key.trim();
    expected = createHmac('sha256', key).update(payload).digest(encoding);
  }
  const left = Buffer.from(signature), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
