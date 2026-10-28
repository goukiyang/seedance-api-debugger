import 'server-only';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const PRIVATE_PROMPT_FORMAT = 'private-prompt.v1' as const;
export const PRIVATE_PROMPT_READER = 1;
export const PRIVATE_PROMPT_STATES = ['legacy-read', 'compatible-read', 'encrypted-write', 'migrated-verified', 'encrypted-required'] as const;
export type PrivatePromptState = typeof PRIVATE_PROMPT_STATES[number];
export type PrivateOrigin = { kind: string; id: string; ownerId: string };
export const ADMINISTERED_PRIVATE_ORIGIN = 'system:administrators';
const administeredKinds = ['image-global', 'video-global', 'multiview-preset', 'multiview-action-format', 'multiview-action-sync', 'context-index', 'provider-credential'];
export type PrivateBinding = { kind: string; id: string; field: string; origins: PrivateOrigin[] };
export type PrivateKeyDomain = 'body' | 'index' | 'backup';
export type PrivatePromptPolicy = {
  schema: 'private-prompt-policy.v1'; revision: string; state: PrivatePromptState; minimumReader: number;
  identities: Array<{ userId: string; tenant: string; subject: string; administrator?: boolean }>;
  origins: PrivateOrigin[];
  authorKinds: Array<{ ownerId: string; kinds: string[] }>;
  keys: Record<PrivateKeyDomain, { active: string; files: Record<string, string> }>;
  destinations: Array<{ endpoint: string; provider: string; credentialVersion: string; models: string[] }>;
  consumers: string[];
  activation?: { inventoryId: string; restoreId: string; writerFenceId: string; attestationFile: string };
  migrationVerified?: { inventoryId: string; restoreId: string; remainingPlaintext: number };
};
export type StoredPrivatePrompt = {
  format: typeof PRIVATE_PROMPT_FORMAT; keyId: string; nonce: string; tag: string; ciphertext: string;
  binding: PrivateBinding;
};
export class PrivatePromptError extends Error {
  deliveryAttempted = false;
  readonly status = 503;
  readonly code = 'PRIVATE_PROMPT_UNAVAILABLE';
  constructor() { super('私密设置暂不可用，原输入和请求编号已保留；请稍后重试或联系维护人员'); }
}
export const isPrivatePromptError = (error: unknown): error is PrivatePromptError => error instanceof PrivatePromptError;
const fail = (): never => { throw new PrivatePromptError(); };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,240}$/.test(value);
const PREFIX = 'ppenc:v1:';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const equal = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

function canonicalOrigins(origins: PrivateOrigin[]) {
  if (!Array.isArray(origins) || !origins.length || origins.length > 32) return fail();
  const unique = new Map<string, PrivateOrigin>();
  for (const origin of origins) {
    if (!record(origin) || Object.keys(origin).sort().join(',') !== 'id,kind,ownerId'
      || !identifier(origin.kind) || !identifier(origin.id) || !identifier(origin.ownerId)) return fail();
    unique.set(JSON.stringify([origin.kind, origin.id, origin.ownerId]), { kind: origin.kind, id: origin.id, ownerId: origin.ownerId });
  }
  return Array.from(unique.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}
export function canonicalPrivateBinding(binding: PrivateBinding): PrivateBinding {
  if (!record(binding) || Object.keys(binding).sort().join(',') !== 'field,id,kind,origins'
    || !identifier(binding.kind) || !identifier(binding.id) || !identifier(binding.field)) return fail();
  return { kind: binding.kind, id: binding.id, field: binding.field, origins: canonicalOrigins(binding.origins) };
}

// No symlink following and no group/world-readable key material. Never include a path or bytes in errors.
function restrictedFile(file: string, maximumBytes: number) {
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(file) || realpathSync(file) !== file) return fail();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximumBytes || (stat.mode & 0o077) !== 0
      || stat.uid !== 0 && stat.uid !== process.getuid?.()) return fail();
    return readFileSync(fd);
  } catch { return fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function externalKeyFile(file: string) {
  const fixture = process.env.NODE_ENV === 'test' ? process.env.PRIVATE_PROMPTS_FIXTURE_ROOT : undefined;
  const allowed = fixture ? path.resolve(fixture) : '/etc/video-api-debugger/private-prompts';
  const resolved = path.resolve(file);
  if (!resolved.startsWith(allowed + path.sep) || resolved.startsWith(process.cwd() + path.sep)) return fail();
  return restrictedFile(resolved, 32);
}
function controlledFile(file: string, maximumBytes: number) {
  const fixture = process.env.NODE_ENV === 'test' ? process.env.PRIVATE_PROMPTS_FIXTURE_ROOT : undefined;
  const allowed = fixture ? path.resolve(fixture) : '/etc/video-api-debugger/private-prompts';
  if (!path.resolve(file).startsWith(allowed + path.sep) || path.resolve(file).startsWith(process.cwd() + path.sep)) return fail();
  return restrictedFile(file, maximumBytes);
}
export function privatePromptPolicy(): PrivatePromptPolicy | null {
  const minimum = process.env.PRIVATE_PROMPTS_MIN_STATE || 'legacy-read';
  if (!(PRIVATE_PROMPT_STATES as readonly string[]).includes(minimum)) return fail();
  const file = process.env.PRIVATE_PROMPTS_POLICY_FILE;
  if (!file) return minimum === 'legacy-read' ? null : fail();
  try {
    const policy = JSON.parse(controlledFile(file, 256 * 1024).toString('utf8')) as PrivatePromptPolicy;
    if (policy.schema !== 'private-prompt-policy.v1' || !identifier(policy.revision)
      || !PRIVATE_PROMPT_STATES.includes(policy.state) || policy.minimumReader !== PRIVATE_PROMPT_READER
      || PRIVATE_PROMPT_STATES.indexOf(policy.state) < PRIVATE_PROMPT_STATES.indexOf(minimum as PrivatePromptState)
      || !Array.isArray(policy.identities) || !Array.isArray(policy.origins) || !Array.isArray(policy.authorKinds)
      || !Array.isArray(policy.destinations) || !Array.isArray(policy.consumers)) return fail();
    for (const identity of policy.identities) {
      if (!identifier(identity.userId) || !identifier(identity.tenant) || !identifier(identity.subject)
        || identity.administrator !== undefined && typeof identity.administrator !== 'boolean') return fail();
    }
    if (new Set(policy.identities.map(identity => identity.userId)).size !== policy.identities.length) return fail();
    if (!policy.consumers.length || !policy.consumers.every(identifier)
      || new Set(policy.consumers).size !== policy.consumers.length) return fail();
    for (const destination of policy.destinations) {
      if (!record(destination) || !identifier(destination.provider) || typeof destination.endpoint !== 'string'
        || typeof destination.credentialVersion !== 'string' || !/^ppidx:v1:[A-Za-z0-9_.:/-]+:[a-f0-9]{64}$/.test(destination.credentialVersion)
        || !Array.isArray(destination.models) || !destination.models.length || !destination.models.every(identifier)) return fail();
      const url = new URL(destination.endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== destination.endpoint) return fail();
    }
    for (const origin of policy.origins) canonicalOrigins([origin]);
    for (const author of policy.authorKinds) {
      if (!identifier(author.ownerId) || !Array.isArray(author.kinds) || !author.kinds.every(identifier)) return fail();
    }
    const owners = new Set(policy.identities.map(identity => identity.userId));
    // Explicit inventoried ownership is independent of whether that author has
    // completed identity binding. Missing identity never grants original-text access.
    if (policy.origins.some(origin => origin.ownerId === ADMINISTERED_PRIVATE_ORIGIN && !administeredKinds.includes(origin.kind))
      || policy.authorKinds.some(author => !owners.has(author.ownerId))) return fail();
    const files: string[] = [];
    for (const domain of ['body', 'index', 'backup'] as const) {
      const keyring = policy.keys?.[domain];
      if (!keyring || !identifier(keyring.active) || !record(keyring.files) || !keyring.files[keyring.active]) return fail();
      for (const [id, keyFile] of Object.entries(keyring.files)) {
        if (!identifier(id) || typeof keyFile !== 'string' || !path.isAbsolute(keyFile)) return fail();
        files.push(path.resolve(keyFile));
      }
    }
    if (new Set(files).size !== files.length) return fail();
    if (PRIVATE_PROMPT_STATES.indexOf(policy.state) >= 2) {
      const activation = policy.activation;
      if (!activation || !identifier(activation.inventoryId) || !identifier(activation.restoreId)
        || !identifier(activation.writerFenceId) || typeof activation.attestationFile !== 'string') return fail();
      const proof = JSON.parse(controlledFile(activation.attestationFile, 256 * 1024).toString('utf8'));
      if (!record(proof) || proof.schema !== 'private-prompt-consumers.v1' || proof.policyRevision !== policy.revision
        || proof.inventoryId !== activation.inventoryId || proof.restoreId !== activation.restoreId
        || proof.writerFenceId !== activation.writerFenceId || !Array.isArray(proof.consumers)
        || proof.consumers.length !== policy.consumers.length) return fail();
      const found = new Set<string>();
      for (const consumer of proof.consumers) {
        if (!record(consumer) || typeof consumer.id !== 'string' || !policy.consumers.includes(consumer.id)
          || found.has(consumer.id) || consumer.reader !== PRIVATE_PROMPT_READER || consumer.permissionContract !== 1
          || typeof consumer.sourceRevision !== 'string' || !/^[a-f0-9]{40,64}$/.test(consumer.sourceRevision)) return fail();
        found.add(consumer.id);
      }
      const active = proof.consumers.find(consumer => consumer.id === process.env.PRIVATE_PROMPTS_CONSUMER_ID);
      if (!active || active.sourceRevision !== process.env.PRIVATE_PROMPTS_RUNTIME_REVISION) return fail();
    }
    if (PRIVATE_PROMPT_STATES.indexOf(policy.state) >= 3 && (!policy.migrationVerified
      || !identifier(policy.migrationVerified.inventoryId) || !identifier(policy.migrationVerified.restoreId)
      || policy.migrationVerified.inventoryId !== policy.activation?.inventoryId
      || policy.migrationVerified.restoreId !== policy.activation?.restoreId
      || policy.migrationVerified.remainingPlaintext !== 0)) return fail();
    return policy;
  } catch { return fail(); }
}
export function privatePromptState() { return privatePromptPolicy()?.state || 'legacy-read'; }
export function privateOrigin(kind: string, id: string, originalOwnerId?: string | null): PrivateOrigin | null {
  const policy = privatePromptPolicy();
  if (!policy) return null;
  const matches = policy.origins.filter(origin => origin.kind === kind && origin.id === id);
  if (matches.length > 1 || matches.length && originalOwnerId && matches[0].ownerId !== originalOwnerId) return fail();
  if (matches.length) return matches[0];
  if (administeredKinds.includes(kind)) {
    if (originalOwnerId && originalOwnerId !== ADMINISTERED_PRIVATE_ORIGIN) return fail();
    return { kind, id, ownerId: ADMINISTERED_PRIVATE_ORIGIN };
  }
  if (originalOwnerId && policy.authorKinds.some(author => author.ownerId === originalOwnerId && author.kinds.includes(kind))) {
    return { kind, id, ownerId: originalOwnerId };
  }
  return null;
}
export function assertPrivateOrigins(origins: PrivateOrigin[]) {
  for (const origin of canonicalOrigins(origins)) {
    const trusted = privateOrigin(origin.kind, origin.id, origin.ownerId);
    if (!trusted) return fail();
  }
}
export function privatePromptKey(domain: PrivateKeyDomain, keyId?: string) {
  const policy = privatePromptPolicy();
  if (!policy) return fail();
  const ring = policy.keys[domain], id = keyId || ring.active, file = ring.files[id];
  if (!file) return fail();
  const key = externalKeyFile(file);
  try {
    if (key.length !== 32) return fail();
    for (const otherDomain of ['body', 'index', 'backup'] as const) {
      if (otherDomain === domain) continue;
      for (const otherFile of Object.values(policy.keys[otherDomain].files)) {
        const other = externalKeyFile(otherFile);
        try { if (other.length !== 32 || timingSafeEqual(key, other)) return fail(); }
        finally { other.fill(0); }
      }
    }
    return { keyId: id, key };
  } catch (error) { key.fill(0); throw error; }
}
export function privatePromptIndex(domain: string, value: string, existingKeyId?: string) {
  if (!identifier(domain)) return fail();
  const { key, keyId } = privatePromptKey('index', existingKeyId);
  try { return `ppidx:v1:${keyId}:${createHmac('sha256', key).update(JSON.stringify([domain, value])).digest('hex')}`; }
  finally { key.fill(0); }
}
function aad(binding: PrivateBinding, keyId: string) {
  return Buffer.from(JSON.stringify({ format: PRIVATE_PROMPT_FORMAT, keyId, binding: canonicalPrivateBinding(binding) }), 'utf8');
}
export function isStoredPrivatePrompt(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('ppenc:');
}
export function inspectPrivatePrompt(raw: string): StoredPrivatePrompt {
  try {
    if (!raw.startsWith(PREFIX) || Buffer.byteLength(raw) > MAX_BODY_BYTES * 2) return fail();
    const value = JSON.parse(raw.slice(PREFIX.length)) as StoredPrivatePrompt;
    if (!record(value) || Object.keys(value).sort().join(',') !== 'binding,ciphertext,format,keyId,nonce,tag'
      || value.format !== PRIVATE_PROMPT_FORMAT || !identifier(value.keyId)) return fail();
    canonicalPrivateBinding(value.binding);
    for (const [field, length] of [['nonce', 12], ['tag', 16], ['ciphertext', null]] as const) {
      const text = value[field];
      if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return fail();
      const bytes = Buffer.from(text, 'base64url');
      if (bytes.toString('base64url') !== text || length !== null && bytes.length !== length || bytes.length > MAX_BODY_BYTES) return fail();
    }
    return value;
  } catch { return fail(); }
}
export function sealPrivatePrompt(text: string, binding: PrivateBinding): string {
  if (process.env.PRIVATE_PROMPTS_READ_ONLY === '1') return fail();
  if (typeof text !== 'string' || isStoredPrivatePrompt(text) || Buffer.byteLength(text) > MAX_BODY_BYTES) return fail();
  const normalized = canonicalPrivateBinding(binding);
  assertPrivateOrigins(normalized.origins);
  const { key, keyId } = privatePromptKey('body');
  try {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(normalized, keyId));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
    const envelope: StoredPrivatePrompt = { format: PRIVATE_PROMPT_FORMAT, keyId, binding: normalized,
      nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    return PREFIX + JSON.stringify(envelope);
  } finally { key.fill(0); }
}
export function openPrivatePrompt(raw: string, binding: PrivateBinding): string {
  const value = inspectPrivatePrompt(raw), normalized = canonicalPrivateBinding(binding);
  if (!equal(JSON.stringify(value.binding), JSON.stringify(normalized))) return fail();
  assertPrivateOrigins(normalized.origins);
  const { key } = privatePromptKey('body', value.keyId);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64url'), { authTagLength: 16 });
    decipher.setAAD(aad(normalized, value.keyId));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    const bytes = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    bytes.fill(0);
    return text;
  } catch { return fail(); }
  finally { key.fill(0); }
}
export function readPrivatePrompt(raw: unknown, binding: PrivateBinding | null): string {
  if (typeof raw !== 'string') return fail();
  if (isStoredPrivatePrompt(raw)) {
    if (!binding) return fail();
    return openPrivatePrompt(raw, binding);
  }
  if (binding) {
    assertPrivateOrigins(binding.origins);
    if (privatePromptState() === 'encrypted-required') return fail();
  }
  return raw;
}
export function writePrivatePrompt(text: string, binding: PrivateBinding | null): string {
  if (isStoredPrivatePrompt(text)) return fail();
  if (!binding) return text;
  if (process.env.PRIVATE_PROMPTS_READ_ONLY === '1') return fail();
  assertPrivateOrigins(binding.origins);
  const state = privatePromptState();
  if (state === 'legacy-read' || state === 'compatible-read') return text;
  return sealPrivatePrompt(text, binding);
}
