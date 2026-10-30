import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE_MAX_AGE, type VerifiedFeishuSession } from '@/lib/auth/session-account-binding';
import { assertPrivateOrigins, privatePromptPolicy, type PrivateOrigin } from './private-prompts.server';

export const PRIVATE_IDENTITY_COOKIE = 'private_prompt_identity';
// Only a fresh verified callback uses this lifetime; old proofs keep their signed expiry.
export const PRIVATE_IDENTITY_SECONDS = SESSION_COOKIE_MAX_AGE;
type IdentityProof = { version: 1; authority: 'author' | 'administrator'; userId: string; tenant: string; subject: string; session: string; issuedAt: number; expiresAt: number };
type Principal = { id: string; role?: string; feishu?: { tenant_key: string | null; open_id: string | null } };
type VerifiedIdentity = Pick<IdentityProof, 'authority' | 'tenant' | 'subject' | 'issuedAt' | 'expiresAt'>;
const verified = new WeakMap<object, VerifiedIdentity>();
const authenticatedOAuth = new WeakMap<object, VerifiedFeishuSession>();
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

// The session reader calls this only after verifying the site's HMAC and the
// current account. The OAuth fact survives a missing/changed private policy;
// that policy remains a separate, fresh authorization check on every request.
export function authenticateVerifiedFeishuSession(user: Principal, source: VerifiedFeishuSession): boolean {
  verified.delete(user);
  authenticatedOAuth.set(user, source);
  try {
    secret();
    if (!source.tenant || source.subject !== user.feishu?.open_id || source.tenant !== user.feishu?.tenant_key) return false;
    const binding = privatePromptPolicy()?.identities.find(item => item.userId === user.id);
    if (!binding || binding.tenant !== source.tenant || binding.subject !== source.subject) return false;
    verified.set(user, { authority: user.role === 'admin' && binding.administrator === true ? 'administrator' : 'author',
      tenant: source.tenant, subject: source.subject, issuedAt: source.issuedAt, expiresAt: source.expiresAt });
    return true;
  } catch { return false; }
}
export function privatePromptCapabilities(user: Principal, origins: PrivateOrigin[]) {
  if (origins.length) assertPrivateOrigins(origins);
  const policy = privatePromptPolicy();
  const binding = policy?.identities.find(identity => identity.userId === user.id);
  const proof = verified.get(user);
  const source = authenticatedOAuth.get(user);
  const owner = origins.length > 0 && origins.every(origin => origin.ownerId === user.id);
  const administrator = user.role === 'admin';
  const authorProof = owner && proof?.authority === 'author'
    && binding?.tenant === proof.tenant && binding.subject === proof.subject;
  const administratorProof = administrator && proof?.authority === 'administrator'
    && binding?.administrator === true && binding.tenant === proof.tenant && binding.subject === proof.subject;
  const valid = Boolean(proof && proof.expiresAt > Date.now() && (administratorProof || authorProof));
  let identityReason = '';
  if ((owner || administrator) && !valid) {
    if (!policy) identityReason = '创作者权限暂不可用，请联系管理员';
    else if (!binding) identityReason = '当前账号尚未开通创作者权限，请联系管理员';
    else if (source && (source.tenant !== binding.tenant || source.subject !== binding.subject)
      || user.feishu?.tenant_key && user.feishu.open_id
        && (user.feishu.tenant_key !== binding.tenant || user.feishu.open_id !== binding.subject)) {
      identityReason = '当前飞书身份与创作者权限不匹配，请联系管理员';
    } else if (!owner && administrator && !binding.administrator) identityReason = '当前账号没有此项管理权限，请联系管理员';
    else if (source) identityReason = '当前登录的创作者权限暂不可用，请联系管理员';
  }
  return { canReadPrivatePrompt: valid, canEditPrivatePrompt: valid,
    requiresIdentityVerification: (owner || administrator) && !valid && !identityReason, identityReason };
}
export class PrivatePromptAccessError extends Error {
  readonly status = 403;
  readonly code: 'PRIVATE_PROMPT_IDENTITY_REQUIRED' | 'PRIVATE_PROMPT_PERMISSION_REQUIRED';
  constructor(reason?: string) {
    super(reason || '此操作需要创作者或管理员通过飞书验证身份，当前输入保留');
    this.code = reason ? 'PRIVATE_PROMPT_PERMISSION_REQUIRED' : 'PRIVATE_PROMPT_IDENTITY_REQUIRED';
  }
}
export function requirePrivatePromptIdentity(user: Principal, origins: PrivateOrigin[]) {
  const capability = privatePromptCapabilities(user, origins);
  if (!capability.canReadPrivatePrompt) {
    throw new PrivatePromptAccessError(capability.identityReason || undefined);
  }
}
