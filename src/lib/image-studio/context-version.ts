import { createHash, randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { privateOrigin, privatePromptIndex, privatePromptPolicy, privatePromptState, readPrivatePrompt, writePrivatePrompt, isStoredPrivatePrompt } from '@/lib/security/private-prompts.server';
import { privateFieldBinding } from '@/lib/security/private-prompt-fields.server';

export const MODULE_CONTEXT_VERSION_RULE = 1;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const hashKey = (hash: string) => `studio_context_hash_v1:${hash}`;
const secureIndex = () => !['legacy-read', 'compatible-read'].includes(privatePromptState());
const protectedHashKey = (hash: string, keyId?: string) => `studio_context_hash_v2:${privatePromptIndex('studio-context-hash', hash, keyId)}`;
const codeKey = (code: string) => `studio_context_code_v1:${code}`;
function reverseHash(raw: string, code: string, write = false) {
  const origin = privateOrigin('context-index', 'studio-context-version');
  const origins = origin ? [origin] : [];
  return write ? writePrivatePrompt(raw, origin ? { kind: 'context-index', id: code, field: 'hash', origins } : null)
    : readPrivatePrompt(raw, privateFieldBinding(raw, 'context-index', code, 'hash', origins));
}
async function readMapping(hash: string, tx: Pick<Prisma.TransactionClient, 'platformSetting'>) {
  const policy = privatePromptPolicy();
  const keys = policy ? Object.keys(policy.keys.index.files).map(keyId => protectedHashKey(hash, keyId)) : [];
  if (!policy || policy.state !== 'encrypted-required') keys.push(hashKey(hash));
  let found: string | null = null;
  for (const key of keys) {
    const stored = await tx.platformSetting.findUnique({ where: { key } });
    if (!stored) continue;
    const value = JSON.parse(stored.value_json);
    if (!validContextVersion(value.code) || found && found !== value.code) throw new ContextVersionError();
    const reverse = await tx.platformSetting.findUnique({ where: { key: codeKey(value.code) } });
    if (!reverse || reverseHash(JSON.parse(reverse.value_json).hash, value.code) !== hash) throw new ContextVersionError();
    found = value.code;
  }
  return found;
}
export const validContextVersion = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Z0-9]{5}$/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);

export class ContextVersionError extends Error {
  constructor(message = '模块上下文版本暂时无法读取，请重试', public status = 503) { super(message); }
}

const allocationState = globalThis as typeof globalThis & {
  studioContextWriter?: Promise<void>;
};

export async function withContextVersionRetry<T>(operation: () => Promise<T>): Promise<T> {
  const previous = allocationState.studioContextWriter ?? Promise.resolve();
  let release!: () => void;
  allocationState.studioContextWriter = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await retryContextVersion(operation); }
  finally { release(); }
}

async function retryContextVersion<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await operation(); }
    catch (error) {
      const code = (error as { code?: string }).code;
      const mappingConflict = code === 'P2002' && JSON.stringify((error as { meta?: unknown }).meta ?? {}).includes('key');
      if (!mappingConflict && !['P2034', 'P1008', 'P2024', 'P2028'].includes(code || '')) throw error;
      if (attempt === 4) throw new ContextVersionError('模块上下文版本分配繁忙，请稍后重试');
      await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
  throw new ContextVersionError();
}

// Both unique reservations commit together; a losing concurrent transaction retries as a whole.
export async function bindModuleContextVersion(raw: string, tx: Prisma.TransactionClient): Promise<string> {
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const previous = await readMapping(hash, tx);
  if (previous) return previous;
  const key = secureIndex() ? protectedHashKey(hash) : hashKey(hash);
  // Acquire SQLite's writer before reading a new mapping; the placeholder cannot escape this transaction.
  const existing = await tx.platformSetting.upsert({ where: { key },
    create: { key, value_json: JSON.stringify({ code: null }) }, update: { key } });
  if (JSON.parse(existing.value_json).code !== null) {
    const value = JSON.parse(existing.value_json);
    if (!validContextVersion(value.code)) throw new ContextVersionError();
    const reverse = await tx.platformSetting.findUnique({ where: { key: codeKey(value.code) } });
    if (!reverse || reverseHash(JSON.parse(reverse.value_json).hash, value.code) !== hash) throw new ContextVersionError();
    return value.code;
  }
  for (let attempt = 0; attempt < 64; attempt++) {
    const code = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
    if (!validContextVersion(code)) continue;
    if (await tx.platformSetting.findUnique({ where: { key: codeKey(code) }, select: { id: true } })) continue;
    await tx.platformSetting.create({ data: { key: codeKey(code), value_json: JSON.stringify({ hash: reverseHash(hash, code, true) }) } });
    await tx.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify({ code }) } });
    return code;
  }
  throw new ContextVersionError('模块上下文版本码分配已达重试上限，请联系管理员');
}

const pending = new Map<string, Promise<string>>();
async function readModuleContextVersion(hash: string): Promise<string | null> {
  return readMapping(hash, prisma);
}

export function resolveModuleContextVersion(raw: string): Promise<string> {
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const existing = pending.get(hash);
  if (existing) return existing;
  const operation = readModuleContextVersion(hash).then(code => code ??
    withContextVersionRetry(() => prisma.$transaction(tx => bindModuleContextVersion(raw, tx))))
    .finally(() => pending.delete(hash));
  pending.set(hash, operation);
  return operation;
}

export async function snapshotModuleContextVersion(snapshotJson: string | null): Promise<{ code: string | null; state: 'ready' | 'missing' | 'error' }> {
  let snapshot: Record<string, unknown>;
  try { snapshot = JSON.parse(snapshotJson || '{}'); } catch { return { code: null, state: 'missing' }; }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return { code: null, state: 'missing' };
  if (typeof snapshot.moduleContext !== 'string') return { code: null, state: 'missing' };
  if (snapshot.moduleContextVersionRule === MODULE_CONTEXT_VERSION_RULE && validContextVersion(snapshot.moduleContextVersion)) {
    return { code: snapshot.moduleContextVersion, state: 'ready' };
  }
  if (isStoredPrivatePrompt(snapshot.moduleContext)) return { code: null, state: 'error' };
  try { return { code: await resolveModuleContextVersion(snapshot.moduleContext), state: 'ready' }; }
  catch { return { code: null, state: 'error' }; }
}
