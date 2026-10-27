import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { assertPrivateOrigins, privatePromptPolicy, type PrivateOrigin } from './private-prompts.server';

export const PRIVATE_IDENTITY_COOKIE = 'private_prompt_identity';
export const PRIVATE_IDENTITY_SECONDS = 8 * 60 * 60;
type IdentityProof = { version: 1; authority: 'author' | 'administrator'; userId: string; tenant: string; subject: string; session: string; issuedAt: number; expiresAt: number };
type Principal = { id: string; role?: string };
const verified = new WeakMap<object, IdentityProof>();
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32 || value === 'dev-secret-change-in-production') throw new Error('本人身份验证暂不可用');
  return value;
}
function signature(payload: string) {
  return createHmac('sha256', secret()).update('private-prompt-feishu-proof.v1\0').update(payload).digest('base64url');
}
function exact(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Called only after the OAuth code exchange and access policy have succeeded.
// Database Feishu columns and password authentication never enter this minting path.
export function signVerifiedFeishuIdentity(identity: { userId: string; role: string; tenant: string | null; subject: string | null }, token: string): string | null {
  const policy = privatePromptPolicy();
  if (!identity.tenant || !identity.subject) return null;
  const binding = policy?.identities.find(item => item.userId === identity.userId);
  if (!binding || binding.tenant !== identity.tenant || binding.subject !== identity.subject) return null;
  const administrator = identity.role === 'admin' && binding.administrator === true;
  const now = Date.now();
  const proof: IdentityProof = { version: 1, authority: administrator ? 'administrator' : 'author',
    userId: identity.userId, tenant: identity.tenant, subject: identity.subject,
    session: digest(token), issuedAt: now, expiresAt: now + PRIVATE_IDENTITY_SECONDS * 1000 };
  const payload = Buffer.from(JSON.stringify(proof)).toString('base64url');
  return payload + '.' + signature(payload);
}
export function authenticatePrivateIdentity(user: Principal, raw: string | undefined, token: string): boolean {
  verified.delete(user);
  if (!raw || raw.length > 4096) return false;
  try {
    const [payload, sig, extra] = raw.split('.');
    if (extra !== undefined || !payload || !sig || !exact(sig, signature(payload))) return false;
    const proof = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdentityProof;
    if (!proof || Object.keys(proof).sort().join(',') !== 'authority,expiresAt,issuedAt,session,subject,tenant,userId,version'
      || proof.version !== 1 || proof.userId !== user.id || !exact(proof.session, digest(token))
      || !['author', 'administrator'].includes(proof.authority)
      || typeof proof.tenant !== 'string' || !proof.tenant || typeof proof.subject !== 'string' || !proof.subject
      || !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt)
      || proof.issuedAt > Date.now() || proof.expiresAt <= Date.now()
      || proof.expiresAt - proof.issuedAt > PRIVATE_IDENTITY_SECONDS * 1000) return false;
    const binding = privatePromptPolicy()?.identities.find(item => item.userId === user.id);
    if (proof.authority === 'administrator') {
      if (user.role !== 'admin' || !binding?.administrator || binding.tenant !== proof.tenant || binding.subject !== proof.subject) return false;
    } else if (!binding || binding.tenant !== proof.tenant || binding.subject !== proof.subject) return false;
    verified.set(user, proof);
    return true;
  } catch { return false; }
}
export function privatePromptCapabilities(user: Principal, origins: PrivateOrigin[]) {
  if (origins.length) assertPrivateOrigins(origins);
  const proof = verified.get(user);
  const owner = origins.length > 0 && origins.every(origin => origin.ownerId === user.id);
  const administrator = user.role === 'admin';
  const authorProof = owner && proof?.authority === 'author'
    && privatePromptPolicy()?.identities.some(identity => identity.userId === user.id && identity.tenant === proof.tenant && identity.subject === proof.subject);
  const administratorProof = administrator && proof?.authority === 'administrator'
    && privatePromptPolicy()?.identities.some(identity => identity.userId === user.id && identity.administrator === true
      && identity.tenant === proof.tenant && identity.subject === proof.subject);
  const valid = Boolean(proof && proof.expiresAt > Date.now() && (administratorProof || authorProof));
  return { canReadPrivatePrompt: valid, canEditPrivatePrompt: valid, requiresIdentityVerification: (owner || administrator) && !valid };
}
export class PrivatePromptAccessError extends Error {
  readonly status = 403;
  readonly code = 'PRIVATE_PROMPT_IDENTITY_REQUIRED';
  constructor() { super('此操作需要创作者或管理员通过飞书验证身份，当前输入保留'); }
}
export function requirePrivatePromptIdentity(user: Principal, origins: PrivateOrigin[]) {
  if (!privatePromptCapabilities(user, origins).canReadPrivatePrompt) throw new PrivatePromptAccessError();
}
