import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { SAFE_RETRY_WRITES_ENABLED } from './build-mode';
import { matchingRetryRule, RETRY_CONFIG_KEY, RETRY_POLICY_VERSION, RETRY_RULES, RETRY_TASK_PREFIX,
  type RetryFailure, type RetryRule, type RetryScope } from './contracts';

type DB = Prisma.TransactionClient;
export type RetryAttempt = { ordinal: number; key: string; state: 'prepared' | 'sent' | 'accepted' | 'free_failed' | 'succeeded' | 'failed' | 'unknown';
  startedAt: string; providerTaskId?: string; failure?: RetryFailure; rule?: { id: string; version: string; evidence: string } };
export type RetryRecord = { schema: typeof RETRY_POLICY_VERSION; kind: 'image' | 'video'; taskId: string; ownerId: string;
  scope: RetryScope; inputHash: string; ruleIds: string[]; maxRetries: 3; stopped: boolean;
  state: 'active' | 'wait' | 'succeeded' | 'failed' | 'unknown'; dueAt?: string; attempts: RetryAttempt[] };
export const retryKey = (kind: RetryRecord['kind'], id: string) => `${RETRY_TASK_PREFIX}${kind}:${id}`;
export const retryHash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function readRetry(kind: RetryRecord['kind'], id: string, db: DB = prisma) {
  const row = await db.platformSetting.findUnique({ where: { key: retryKey(kind, id) } });
  return row ? { row, value: JSON.parse(row.value_json) as RetryRecord } : null;
}
export async function retryConfig(db: DB = prisma) {
  const row = await db.platformSetting.findUnique({ where: { key: RETRY_CONFIG_KEY } });
  const value = row ? JSON.parse(row.value_json) as { revision: string; enabledIds: string[] } : { revision: 'initial', enabledIds: [] };
  return { row, ...value };
}
export async function writeRetry(db: DB, previous: NonNullable<Awaited<ReturnType<typeof readRetry>>>, value: RetryRecord) {
  const changed = await db.platformSetting.updateMany({ where: { key: previous.row.key, value_json: previous.row.value_json }, data: { value_json: JSON.stringify(value) } });
  if (changed.count !== 1) throw new Error('retry_state_changed');
}
export async function beginRetry(input: Pick<RetryRecord, 'kind' | 'taskId' | 'ownerId' | 'scope' | 'inputHash'>, db: DB = prisma, frozenRuleIds?: string[]) {
  const prior = await readRetry(input.kind, input.taskId, db);
  if (prior) {
    if (prior.value.ownerId !== input.ownerId || prior.value.inputHash !== input.inputHash
      || JSON.stringify(prior.value.scope) !== JSON.stringify(input.scope)) throw new Error('retry_frozen_input_changed');
    return prior.value;
  }
  const config = await retryConfig(db);
  const value: RetryRecord = { schema: RETRY_POLICY_VERSION, ...input,
    ruleIds: frozenRuleIds || RETRY_RULES.filter(rule => config.enabledIds.includes(rule.id)).map(rule => `${rule.id}@${rule.version}`), maxRetries: 3, stopped: false, state: 'active',
    attempts: [{ ordinal: 0, key: input.taskId, state: 'prepared', startedAt: new Date().toISOString() }] };
  await db.platformSetting.create({ data: { key: retryKey(input.kind, input.taskId), value_json: JSON.stringify(value) } });
  return value;
}
export async function mutateRetry(kind: RetryRecord['kind'], id: string, apply: (value: RetryRecord, db: DB) => Promise<void> | void) {
  return prisma.$transaction(async db => {
    const prior = await readRetry(kind, id, db);
    if (!prior) return null;
    const value = structuredClone(prior.value);
    await apply(value, db); await writeRetry(db, prior, value); return value;
  }, { timeout: 15000 });
}
export async function markRetrySent(kind: RetryRecord['kind'], id: string) {
  return mutateRetry(kind, id, async (value, db) => {
    const attempt = value.attempts.at(-1)!;
    if (value.state !== 'active' || attempt.state !== 'prepared' || value.stopped && attempt.ordinal > 0) throw new Error('retry_send_not_authorized');
    if (attempt.ordinal > 0) {
      const previous = value.attempts[attempt.ordinal - 1], config = await retryConfig(db);
      if (!SAFE_RETRY_WRITES_ENABLED || process.env.SAFE_GENERATION_RETRY_DISABLED === '1' || previous.state !== 'free_failed'
        || !previous.rule || !config.enabledIds.includes(previous.rule.id)) throw new Error('retry_send_not_authorized');
    }
    attempt.state = 'sent';
  });
}
export async function acceptRetry(kind: RetryRecord['kind'], id: string, providerTaskId: string) {
  return mutateRetry(kind, id, value => {
    const attempt = value.attempts.at(-1)!;
    if (attempt.providerTaskId && attempt.providerTaskId !== providerTaskId) throw new Error('retry_provider_identity_changed');
    attempt.providerTaskId = providerTaskId; attempt.state = 'accepted';
  });
}
export async function finishRetry(kind: RetryRecord['kind'], id: string, state: 'succeeded' | 'failed' | 'unknown') {
  return mutateRetry(kind, id, value => { value.state = state; const attempt = value.attempts.at(-1)!;
    if (attempt.state !== 'free_failed' || state !== 'failed') attempt.state = state; });
}

/** Runs inside the same transaction as the parent state change, before any settlement. */
export async function planRetry(db: DB, kind: RetryRecord['kind'], id: string, failure: RetryFailure,
  allowed: boolean, rules: readonly RetryRule[] = RETRY_RULES) {
  const prior = await readRetry(kind, id, db);
  if (!prior || prior.value.state !== 'active') return false;
  const value = structuredClone(prior.value), attempt = value.attempts.at(-1)!;
  if (failure.providerTaskId && attempt.providerTaskId !== failure.providerTaskId) return false;
  attempt.failure = failure;
  const config = await retryConfig(db);
  const rule = matchingRetryRule(value.scope, failure, value.ruleIds, config.enabledIds, rules);
  if (!rule) { await writeRetry(db, prior, value); return false; }
  attempt.state = 'free_failed'; attempt.rule = { id: rule.id, version: rule.version, evidence: rule.evidence };
  const schedule = allowed && !value.stopped && SAFE_RETRY_WRITES_ENABLED && process.env.SAFE_GENERATION_RETRY_DISABLED !== '1' && attempt.ordinal < 3;
  if (schedule) {
    value.state = 'wait';
    value.dueAt = new Date(Date.now() + Math.max([10000, 30000, 90000][attempt.ordinal], failure.retryAfterMs || 0)).toISOString();
  } else value.state = 'failed';
  await writeRetry(db, prior, value);
  return schedule;
}
export async function advanceRetry(db: DB, kind: RetryRecord['kind'], id: string) {
  const prior = await readRetry(kind, id, db);
  if (!prior || prior.value.state !== 'wait' || Date.parse(prior.value.dueAt!) > Date.now()) return null;
  const value = structuredClone(prior.value), last = value.attempts.at(-1)!;
  const config = await retryConfig(db);
  if (value.stopped || !SAFE_RETRY_WRITES_ENABLED || process.env.SAFE_GENERATION_RETRY_DISABLED === '1' || !last.rule || !config.enabledIds.includes(last.rule.id)) return null;
  if (last.state !== 'free_failed' || last.ordinal >= 3) throw new Error('retry_prior_not_closed');
  const ordinal = last.ordinal + 1;
  value.attempts.push({ ordinal, key: `${id}-r${ordinal}-${randomUUID()}`, state: 'prepared', startedAt: new Date().toISOString() });
  value.state = 'active'; delete value.dueAt;
  await writeRetry(db, prior, value); return value;
}
export function publicRetry(value: RetryRecord | null | undefined) {
  return value ? { state: value.state, retries: value.attempts.length - 1, maxRetries: value.maxRetries, stopped: value.stopped,
    dueAt: value.dueAt, canStop: !value.stopped && ['active', 'wait'].includes(value.state),
    attempts: value.attempts.map(a => ({ ordinal: a.ordinal, state: a.state, startedAt: a.startedAt,
      code: a.rule ? a.failure?.code || null : null, fee: a.state === 'free_failed' ? 'confirmed_no_charge' : 'original_accounting', ruleVersion: a.rule?.version || null })) } : null;
}
