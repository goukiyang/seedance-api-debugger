import { createHash, randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const MODULE_CONTEXT_VERSION_RULE = 1;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const hashKey = (hash: string) => `studio_context_hash_v1:${hash}`;
const codeKey = (code: string) => `studio_context_code_v1:${code}`;
export const validContextVersion = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Z0-9]{5}$/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);

export class ContextVersionError extends Error {
  constructor(message = '模块上下文版本暂时无法读取，请重试', public status = 503) { super(message); }
}

export async function withContextVersionRetry<T>(operation: () => Promise<T>): Promise<T> {
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
  const existing = await tx.platformSetting.findUnique({ where: { key: hashKey(hash) } });
  if (existing) {
    const value = JSON.parse(existing.value_json);
    if (!validContextVersion(value.code)) throw new ContextVersionError();
    const reverse = await tx.platformSetting.findUnique({ where: { key: codeKey(value.code) } });
    if (!reverse || JSON.parse(reverse.value_json).hash !== hash) throw new ContextVersionError();
    return value.code;
  }
  for (let attempt = 0; attempt < 64; attempt++) {
    const code = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
    if (!validContextVersion(code)) continue;
    if (await tx.platformSetting.findUnique({ where: { key: codeKey(code) }, select: { id: true } })) continue;
    await tx.platformSetting.create({ data: { key: codeKey(code), value_json: JSON.stringify({ hash }) } });
    await tx.platformSetting.create({ data: { key: hashKey(hash), value_json: JSON.stringify({ code }) } });
    return code;
  }
  throw new ContextVersionError('模块上下文版本码分配已达重试上限，请联系管理员');
}

const pending = new Map<string, Promise<string>>();
export function resolveModuleContextVersion(raw: string): Promise<string> {
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const existing = pending.get(hash);
  if (existing) return existing;
  const operation = withContextVersionRetry(() => prisma.$transaction(tx => bindModuleContextVersion(raw, tx)))
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
  try { return { code: await resolveModuleContextVersion(snapshot.moduleContext), state: 'ready' }; }
  catch { return { code: null, state: 'error' }; }
}
