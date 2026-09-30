import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { USER_PROFILE_OPTIONS } from '@/lib/users/profiles';
import { nextQuotaStart, quotaMatches, quotaRevision, quotaWindow, type QuotaAssignment, type QuotaBinding,
  type QuotaCatalog, type QuotaConfig, type QuotaPerson, type QuotaRule } from './periodic-types';

type Tx = Prisma.TransactionClient;
export const QUOTA_KEY = 'periodic_credit_rules_v1';
const ASSIGNMENT_PREFIX = 'periodic_credit_user:';
const HEARTBEAT_KEY = 'periodic_credit_worker';
export class QuotaError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
function parse<T>(value: string): T {
  try { return JSON.parse(value) as T; } catch { throw new QuotaError('周期额度记录异常，请联系管理员核对，未自动发放。', 503); }
}
export async function readQuotaCatalog(tx: Tx | typeof prisma = prisma): Promise<QuotaCatalog> {
  const row = await tx.platformSetting.findUnique({ where: { key: QUOTA_KEY } });
  if (!row) return { version: 0, rules: [] };
  const result = parse<QuotaCatalog>(row.value_json);
  if (!Array.isArray(result.rules) || !Number.isInteger(result.version)) throw new QuotaError('周期额度配置异常', 503);
  return result;
}
function stringIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) {
    throw new QuotaError('成员或岗位选项无效，单项最多1000人');
  }
  return Array.from(new Set(value));
}
function validateConfig(value: unknown): QuotaConfig {
  if (!value || typeof value !== 'object') throw new QuotaError('缺少额度设置');
  const data = value as QuotaConfig;
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 60) throw new QuotaError('规则名称需为1至60字');
  if (!Number.isSafeInteger(data.amount) || data.amount < 0 || data.amount > 1000000) throw new QuotaError('每人额度需为0至1000000的整数');
  if (!['internal', 'external', 'all'].includes(data.account_type)) throw new QuotaError('账号类型无效');
  if (!['hour', 'day', 'week', 'month'].includes(data.unit) || !Number.isSafeInteger(data.every) || data.every < 1 || data.every > 366) throw new QuotaError('周期需为1至366个小时、天、周或月');
  if (!Number.isSafeInteger(data.max_members) || data.max_members < 1 || data.max_members > 10000) throw new QuotaError('人数上限需为1至10000');
  const anchor = new Date(data.anchor);
  if (!Number.isFinite(anchor.getTime()) || anchor.getUTCFullYear() < 2020 || anchor.getUTCFullYear() > 2100) throw new QuotaError('首次刷新时间无效');
  anchor.setUTCSeconds(0, 0);
  const profiles = stringIds(data.profiles);
  if (profiles.some(id => !USER_PROFILE_OPTIONS.some(p => p.value === id))) throw new QuotaError('岗位不存在');
  const user_ids = stringIds(data.user_ids);
  if (!profiles.length && !user_ids.length) throw new QuotaError('至少选择一个岗位或成员');
  return { name: data.name.trim(), amount: data.amount, account_type: data.account_type, profiles,
    user_ids, exclude_ids: stringIds(data.exclude_ids), unit: data.unit, every: data.every,
    anchor: anchor.toISOString(), max_members: data.max_members };
}
function userWhere(config: QuotaConfig, now: Date): Prisma.UserWhereInput {
  return { role: { not: 'admin' }, status: 'active', ...(config.account_type === 'all' ? {} : { account_type: config.account_type }),
    id: { notIn: config.exclude_ids }, AND: [
      { OR: [{ user_profile: { in: config.profiles } }, { id: { in: config.user_ids } }] },
      { OR: [{ expires_at: null }, { expires_at: { gt: now } }] },
    ] };
}
const userSelect = { id: true, name: true, username: true, avatar_url: true, role: true, status: true,
  account_type: true, user_profile: true, expires_at: true } as const;
async function readAssignment(tx: Tx, userId: string): Promise<QuotaAssignment | null> {
  const row = await tx.platformSetting.findUnique({ where: { key: ASSIGNMENT_PREFIX + userId } });
  return row ? parse<QuotaAssignment>(row.value_json) : null;
}
async function writeAssignment(tx: Tx, userId: string, state: QuotaAssignment) {
  await tx.platformSetting.upsert({ where: { key: ASSIGNMENT_PREFIX + userId },
    create: { key: ASSIGNMENT_PREFIX + userId, value_json: JSON.stringify(state) }, update: { value_json: JSON.stringify(state) } });
}
function binding(rule: QuotaRule, now: Date, start: Date): QuotaBinding {
  const revision = quotaRevision(rule, now)!;
  const window = quotaWindow(revision.config, start);
  return { rule_id: rule.id, revision: revision.version, config: revision.config,
    start: window.start.toISOString(), end: window.end.toISOString() };
}

// This shares the caller's transaction: eligibility, assignment and issuance cannot split.
export async function syncPeriodicQuota(tx: Tx, user: QuotaPerson, now: Date, catalog?: QuotaCatalog, issue = true) {
  const rules = catalog || await readQuotaCatalog(tx);
  let state = await readAssignment(tx, user.id);
  const candidates = rules.rules.filter(rule => rule.status === 'active' && quotaRevision(rule, now)
    && quotaMatches(quotaRevision(rule, now)!.config, user, now));
  if (!state && candidates.length === 0) return { managed: false, granted: false };
  const before = JSON.stringify(state);
  state ||= { managed_since: now.toISOString() };
  const current = state.current;
  const stillCurrent = current && new Date(current.end) > now;
  const pendingRule = rules.rules.find(item => item.id === state?.pending?.rule_id && item.status === 'active');
  const pendingRevision = pendingRule?.revisions.find(item => item.version === state?.pending?.revision);
  const keepFuturePending = !!state.pending && new Date(state.pending.start) > now && !!pendingRevision
    && quotaMatches(pendingRevision.config, user, now);
  if (candidates.length > 1) {
    state.pending = undefined;
    state.eligible_rule_id = undefined;
    await writeAssignment(tx, user.id, state);
    return { managed: true, granted: false, problem: '同时命中多个额度模块，需管理员处理' };
  }
  const rule = candidates[0];
  if (!rule) {
    if (!keepFuturePending) state.pending = undefined;
    state.eligible_rule_id = undefined;
    if (JSON.stringify(state) !== before) await writeAssignment(tx, user.id, state);
    return { managed: true, granted: false };
  }
  const revision = quotaRevision(rule, now)!;
  const liveWindow = quotaWindow(revision.config, now);
  const pendingReady = state.pending?.rule_id === rule.id && new Date(state.pending.start) <= now;
  const canRenew = current?.rule_id === rule.id && state.eligible_rule_id === rule.id && !stillCurrent && (!state.pending || pendingReady);
  if (stillCurrent) {
    if (current.rule_id === rule.id && current.revision === revision.version && !keepFuturePending) state.pending = undefined;
    else if (state.pending?.rule_id !== rule.id || (state.pending.revision < revision.version)) {
      state.pending = binding(rule, now, nextQuotaStart(revision.config, new Date(current.end)));
    }
  } else if ((canRenew || pendingReady) && liveWindow.start <= now) {
    state.current = binding(rule, now, liveWindow.start);
    state.pending = undefined;
  } else if (!state.pending || state.pending.rule_id !== rule.id || state.pending.revision < revision.version) {
    state.pending = binding(rule, now, nextQuotaStart(revision.config, now));
    if (new Date(state.pending.start) <= now) { state.current = state.pending; state.pending = undefined; }
  }
  state.eligible_rule_id = rule.id;
  if (JSON.stringify(state) !== before) await writeAssignment(tx, user.id, state);
  if (!issue) return { managed: true, granted: false };
  const period = state.current;
  if (!period || period.rule_id !== rule.id || new Date(period.start) > now || new Date(period.end) <= now) return { managed: true, granted: false };
  const key = `periodic:${period.rule_id}:${user.id}:${period.start}`;
  if (await tx.creditBucket.findUnique({ where: { idempotency_key: key } })) return { managed: true, granted: false };
  const policyKey = `periodic:${period.rule_id}`;
  const issued = await tx.creditBucket.count({ where: { policy_key: policyKey, quota_date: period.start } });
  if (issued >= period.config.max_members) return { managed: true, granted: false, problem: '本期人数上限已达，未发放' };
  const oldBucket = await tx.creditBucket.findFirst({ where: { user_id: user.id, source_type: 'daily_quota',
    policy_key: { not: policyKey }, status: 'active', expires_at: { gt: now }, amount_remaining: { gt: 0 } } });
  if (oldBucket) {
    state.current = current;
    state.pending = binding(rule, now, nextQuotaStart(revision.config, oldBucket.expires_at!));
    await writeAssignment(tx, user.id, state);
    return { managed: true, granted: false, problem: '原额度尚未到期，新额度顺延至后续周期' };
  }
  const account = await tx.creditAccount.upsert({ where: { user_id: user.id }, update: {}, create: { user_id: user.id } });
  const frozen = await tx.creditBucket.aggregate({ where: { user_id: user.id }, _sum: { frozen_amount: true } });
  // Keep the existing source type so old task snapshots remain compatible; policy_key identifies the rule.
  const bucket = await tx.creditBucket.create({ data: { user_id: user.id, source_type: 'daily_quota',
    amount_total: period.config.amount, amount_remaining: period.config.amount, expires_at: new Date(period.end),
    quota_date: period.start, policy_key: policyKey, policy_snapshot: JSON.stringify(period), idempotency_key: key,
    metadata_json: JSON.stringify({ kind: 'periodic', rule_name: period.config.name, revision: period.revision }) } });
  await tx.creditLedger.create({ data: { user_id: user.id, type: 'periodic_grant', amount: period.config.amount,
    balance_before: account.balance, balance_after: account.balance,
    frozen_before: account.frozen_credits + (frozen._sum.frozen_amount || 0), frozen_after: account.frozen_credits + (frozen._sum.frozen_amount || 0),
    idempotency_key: key, reason: `${period.config.name}：本期额度 ${period.config.amount} 点`,
    metadata_json: JSON.stringify({ rule_id: rule.id, policy_key: policyKey, bucket_id: bucket.id, period_start: period.start, period_end: period.end }) } });
  return { managed: true, granted: true };
}

export async function refreshQuotaMembership(tx: Tx, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: userSelect });
  if (user) await syncPeriodicQuota(tx, user, new Date(), undefined, false);
}

export async function periodicUserState(tx: Tx, userId: string) {
  const state = await readAssignment(tx, userId);
  if (!state) return null;
  const catalog = await readQuotaCatalog(tx);
  const now = new Date();
  const currentRule = catalog.rules.find(r => r.id === state.current?.rule_id);
  const pendingRule = catalog.rules.find(r => r.id === state.pending?.rule_id && r.status === 'active');
  const user = await tx.user.findUnique({ where: { id: userId }, select: userSelect });
  const pendingEligible = pendingRule && user && state.pending && quotaMatches(state.pending.config, user, now);
  const currentEligible = currentRule?.status === 'active' && user && quotaMatches(quotaRevision(currentRule, now)!.config, user, now);
  return { managed: true, rule_name: state.current?.config.name || state.pending?.config.name || null,
    next_refresh: pendingEligible ? state.pending!.start : currentEligible ? state.current?.end : null,
    status: pendingEligible ? 'scheduled' : currentEligible ? 'active' : currentRule?.status === 'paused' ? 'paused' : 'unassigned' };
}

export async function quotaAdminView(ruleId?: string, page = 1, search = '') {
  const catalog = await readQuotaCatalog();
  if (ruleId && !catalog.rules.some(rule => rule.id === ruleId)) throw new QuotaError('规则不存在，请重新读取列表', 404);
  const now = new Date();
  const rules = [];
  for (const rule of catalog.rules) {
    const config = quotaRevision(rule, now)?.config || rule.draft;
    const members = await prisma.user.count({ where: userWhere(config, now) });
    const window = quotaWindow(config, now);
    const next = window.start > now ? window.start : window.end;
    const latest = await prisma.operationLog.findFirst({ where: { action: 'periodic_quota_batch', target_id: { in: [rule.id, 'all'] } }, orderBy: { created_at: 'desc' }, select: { detail: true, created_at: true } });
    rules.push({ ...rule, effective_config: config, members, publish_at: (rule.revisions.length ? window.end : new Date(rule.draft.anchor)).toISOString(), next_refresh: next.toISOString(), last_execution: latest ? { ...parse<object>(latest.detail || '{}'), at: latest.created_at } : null });
  }
  const selected = catalog.rules.find(r => r.id === ruleId);
  const where: Prisma.UserWhereInput = selected ? userWhere(quotaRevision(selected, now)?.config || selected.draft, now) : { status: 'active', role: { not: 'admin' } };
  const filter: Prisma.UserWhereInput = { AND: [where, ...(search ? [{ OR: [{ name: { contains: search } }, { username: { contains: search } }] }] : [])] };
  const total = await prisma.user.count({ where: filter });
  const people = await prisma.user.findMany({ where: filter, select: userSelect, orderBy: { id: 'asc' }, take: 40, skip: (page - 1) * 40 });
  const logs = ruleId ? await prisma.operationLog.findMany({ where: { target_type: 'PeriodicQuota', target_id: { in: [ruleId, 'all'] } },
    orderBy: { created_at: 'desc' }, take: 30, select: { id: true, action: true, detail: true, created_at: true } }) : [];
  const worker = await prisma.platformSetting.findUnique({ where: { key: HEARTBEAT_KEY } });
  return { version: catalog.version, rules, people, total, page, logs: logs.map(log => ({ ...log, detail: parse<object>(log.detail || '{}') })),
    worker: worker ? parse<object>(worker.value_json) : null };
}

export async function changeQuotaRule(body: Record<string, unknown>, adminId: string) {
  if (typeof body.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.request_id)) throw new QuotaError('缺少有效操作编号');
  const commandKey = `periodic_credit_command:${body.request_id}`;
  return prisma.$transaction(async tx => {
    const previous = await tx.platformSetting.findUnique({ where: { key: commandKey } });
    if (previous) {
      const record = parse<{ admin: string; body: string; result: unknown }>(previous.value_json);
      if (record.admin !== adminId || record.body !== JSON.stringify(body)) throw new QuotaError('操作编号已被其他请求使用', 409);
      return record.result;
    }
    const catalog = await readQuotaCatalog(tx);
    if (body.expected_version !== catalog.version) throw new QuotaError('其他管理员已更新规则，请重新读取后再保存', 409);
    const now = new Date();
    let rule = catalog.rules.find(item => item.id === body.id);
    const action = body.action;
    if (action === 'save') {
      const config = validateConfig(body.config);
      const ids = Array.from(new Set([...config.user_ids, ...config.exclude_ids]));
      if (ids.length && await tx.user.count({ where: { id: { in: ids }, status: { not: 'deleted' } } }) !== ids.length) throw new QuotaError('所选成员中有已删除或不存在的账号');
      if (!rule) {
        if (body.id) throw new QuotaError('规则不存在', 404);
        if (catalog.rules.length >= 50) throw new QuotaError('最多保留50个规则，请整理现有规则');
        rule = { id: randomUUID(), status: 'draft', draft: config, revisions: [] };
        catalog.rules.push(rule);
      } else {
        if (rule.status === 'archived') throw new QuotaError('归档规则不能编辑，可复制为新草稿');
        rule.draft = config;
      }
    } else {
      if (!rule) throw new QuotaError('规则不存在', 404);
      if (body.confirm !== true) throw new QuotaError('请确认影响后执行');
      if (action === 'publish') {
        if (rule.status === 'archived') throw new QuotaError('归档规则不能启用');
        const existing = quotaRevision(rule, now);
        if (rule.revisions.some(rev => new Date(rev.effective_at) > now)) throw new QuotaError('已有待生效版本，请等待生效后再发布');
        const config = { ...rule.draft };
        const effectiveAt = existing ? quotaWindow(existing.config, now).end : new Date(config.anchor);
        if (effectiveAt.getTime() < now.getTime() + 60000) throw new QuotaError('首次刷新需至少安排在一分钟之后');
        // An amount/member edit must not move Jan-31 -> Feb-28 -> Mar-28.
        config.anchor = existing && config.unit === existing.config.unit && config.every === existing.config.every
          ? existing.config.anchor : effectiveAt.toISOString();
        const recipients = await tx.user.findMany({ where: userWhere(config, now), select: userSelect, take: config.max_members + 1 });
        if (recipients.length > config.max_members) throw new QuotaError('适用人数超过上限，请调整成员或人数上限');
        for (const other of catalog.rules.filter(item => item.id !== rule!.id && item.status === 'active')) {
          const overlaps = other.revisions.slice(-2).some(rev => recipients.some(person => quotaMatches(rev.config, person, now)));
          if (overlaps) throw new QuotaError(`与“${other.draft.name}”成员重叠，请先排除重复成员`);
        }
        rule.revisions.push({ version: (rule.revisions.at(-1)?.version || 0) + 1, effective_at: effectiveAt.toISOString(), config });
        if (rule.revisions.length > 100) throw new QuotaError('规则历史版本达到上限，请联系管理员归档核对');
        rule.status = 'active';
        // Register membership now, not at the first post-outage visit.
        for (const person of recipients) {
          const assignment: QuotaAssignment = await readAssignment(tx, person.id) || { managed_since: now.toISOString() };
          const end = assignment.current ? new Date(assignment.current.end) : now;
          const starts = nextQuotaStart(config, end > effectiveAt ? end : effectiveAt);
          assignment.pending = { rule_id: rule.id, revision: rule.revisions.at(-1)!.version, config,
            start: starts.toISOString(), end: quotaWindow(config, starts).end.toISOString() };
          assignment.eligible_rule_id = rule.id;
          await writeAssignment(tx, person.id, assignment);
        }
      } else if (action === 'pause' || action === 'archive') {
        rule.status = action === 'pause' ? 'paused' : 'archived';
      } else if (action === 'resume') {
        if (rule.status !== 'paused' || !rule.revisions.length) throw new QuotaError('只有已暂停规则可以恢复');
        const config = quotaRevision(rule, now)!.config;
        const recipients = await tx.user.findMany({ where: userWhere(config, now), select: userSelect, take: config.max_members + 1 });
        if (recipients.length > config.max_members) throw new QuotaError('适用人数超过上限，请调整设置后发布');
        for (const other of catalog.rules.filter(item => item.id !== rule!.id && item.status === 'active')) {
          if (other.revisions.slice(-2).some(rev => recipients.some(person => quotaMatches(rev.config, person, now)))) {
            throw new QuotaError(`与“${other.draft.name}”成员重叠，不能恢复`);
          }
        }
        rule.status = 'active';
      } else throw new QuotaError('未知操作');
    }
    catalog.version++;
    await tx.platformSetting.upsert({ where: { key: QUOTA_KEY }, create: { key: QUOTA_KEY, value_json: JSON.stringify(catalog), updated_by: adminId },
      update: { value_json: JSON.stringify(catalog), updated_by: adminId } });
    const result = { id: rule!.id, version: catalog.version };
    await tx.operationLog.create({ data: { operator_id: adminId, action: `periodic_quota_${action}`, target_type: 'PeriodicQuota', target_id: rule!.id,
      detail: JSON.stringify({ catalog_version: catalog.version, rule: rule!, result }) } });
    await tx.platformSetting.create({ data: { key: commandKey, value_json: JSON.stringify({ admin: adminId, body: JSON.stringify(body), result }) } });
    return result;
  }, { timeout: 30000, maxWait: 10000 });
}

export async function runQuotaBatch(ruleId?: string, operatorId?: string, cursor?: string) {
  if (ruleId) {
    const requested = (await readQuotaCatalog()).rules.find(rule => rule.id === ruleId);
    if (!requested || requested.status !== 'active') throw new QuotaError('规则未启用，不能补齐额度', 409);
  }
  const setting = await prisma.platformSetting.findUnique({ where: { key: QUOTA_KEY }, select: { updated_by: true } });
  const actor = operatorId || setting?.updated_by;
  if (!actor) throw new QuotaError('缺少规则发布记录，请管理员重新发布后执行');
  const rows = await prisma.user.findMany({ where: { status: { not: 'deleted' }, ...(cursor ? { id: { gt: cursor } } : {}) },
    select: userSelect, orderBy: { id: 'asc' }, take: 100 });
  const results = { processed: 0, granted: 0, skipped: 0, failed: 0, failures: [] as { user_id: string; reason: string }[] };
  for (const row of rows) {
    try {
      const outcome = await prisma.$transaction(async tx => {
        const user = await tx.user.findUnique({ where: { id: row.id }, select: userSelect });
        if (!user) return { granted: false };
        const catalog = await readQuotaCatalog(tx);
        if (ruleId) {
          const rule = catalog.rules.find(item => item.id === ruleId);
          if (!rule || rule.status !== 'active') return { granted: false };
          const state = await readAssignment(tx, user.id);
          if (!quotaMatches(quotaRevision(rule, new Date())!.config, user, new Date()) && state?.current?.rule_id !== ruleId) return { granted: false };
        }
        const { expireUserCreditBuckets } = await import('./policy');
        await expireUserCreditBuckets(tx, user.id);
        return syncPeriodicQuota(tx, user, new Date(), catalog);
      }, { timeout: 10000, maxWait: 10000 });
      if ('problem' in outcome && outcome.problem) {
        results.failed++;
        results.failures.push({ user_id: row.id, reason: outcome.problem });
      } else if (outcome.granted) results.granted++; else results.skipped++;
    } catch (error) {
      results.failed++;
      results.failures.push({ user_id: row.id, reason: error instanceof QuotaError ? error.message : '执行失败，可安全重试' });
    }
    results.processed++;
  }
  const next = rows.length === 100 ? rows[rows.length - 1].id : null;
  const result = { ...results, cursor: next, at: new Date().toISOString(), scope: ruleId ? 'rule' : 'all' };
  if (operatorId || results.granted || results.failed) await prisma.operationLog.create({ data: { operator_id: actor, action: 'periodic_quota_batch',
    target_type: 'PeriodicQuota', target_id: ruleId || 'all', detail: JSON.stringify(result) } });
  return result;
}
export async function quotaWorkerTick(cursor?: string) {
  const catalog = await readQuotaCatalog();
  const result = catalog.rules.some(r => r.revisions.length > 0) ? await runQuotaBatch(undefined, undefined, cursor) : null;
  await prisma.platformSetting.upsert({ where: { key: HEARTBEAT_KEY }, create: { key: HEARTBEAT_KEY, value_json: JSON.stringify({ at: new Date().toISOString(), result }) },
    update: { value_json: JSON.stringify({ at: new Date().toISOString(), result }) } });
  return result?.cursor || undefined;
}
