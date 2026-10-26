import { randomBytes, randomUUID } from 'node:crypto';
import type { ApiCustomer } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth/password';
import { maintainAccountSessionBinding } from '@/lib/auth/session-account-binding';
import { normalizeDecimal } from '@/lib/pricing/math';
import { API_SCOPES, CustomerApiError, digest, newApiKey, requestId, stringList, type ApiTx } from './auth';
import { budgetPeriod, PUBLIC_IP_MODEL } from './contracts';
import { publicUsage } from './usage';

export function serializeApiAdmin<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v));
}
const keySelect = { id: true, name: true, prefix: true, active: true, expires_at: true, scopes_json: true, models_json: true,
  requests_per_minute: true, last_used_at: true, created_at: true } as const;

export async function apiAdminSnapshot(id?: string, cursor?: string, keyCursor?: string) {
  const configuration = await prisma.apiConfiguration.findUnique({ where: { id: 'global' } }) || {
    id: 'global', enabled: false, license_confirmed: false, concurrency_limit: null, storage_limit_bytes: null, max_output_bytes: null, revision: 0 };
  if (id) {
    const customer = await prisma.apiCustomer.findUnique({ where: { id }, include: { rates: true, keys: {
      where: keyCursor ? { id: { lt: keyCursor } } : {}, select: keySelect, orderBy: { id: 'desc' }, take: 51 } } });
    if (!customer) throw new CustomerApiError('CUSTOMER_NOT_FOUND', '客户不存在。', 404);
    return serializeApiAdmin({ configuration, customer: { ...customer, keys: customer.keys.slice(0, 50),
      keys_next_cursor: customer.keys.length > 50 ? customer.keys[49].id : null }, usage: await publicUsage({ customer, user: { id: customer.user_id } }, cursor) });
  }
  const customers = await prisma.apiCustomer.findMany({ where: cursor ? { id: { lt: cursor } } : {}, orderBy: { id: 'desc' }, take: 51,
    include: { user: { select: { credit_account: { select: { balance: true, frozen_credits: true } } } }, keys: { select: { last_used_at: true }, orderBy: { last_used_at: 'desc' }, take: 1 } } });
  return serializeApiAdmin({ configuration, customers: customers.slice(0, 50).map(c => ({ id: c.id, name: c.name, revision: c.revision,
    create_enabled: c.create_enabled, read_enabled: c.read_enabled, daily_points: c.daily_points, monthly_points: c.monthly_points,
    balance_points: c.user.credit_account?.balance ?? 0, frozen_points: c.user.credit_account?.frozen_credits ?? 0, last_used_at: c.keys[0]?.last_used_at ?? null })),
    next_cursor: customers.length > 50 ? customers[49].id : null });
}

function text(value: unknown, field: string, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new CustomerApiError('INVALID_SETTING', `${field}无效。`);
  return value.trim();
}
function positive(value: unknown, field: string, max = 10_000_000, scale = 1): number | null {
  if (value === null || value === '' || value === undefined) return null;
  try { return Number(normalizeDecimal(String(value), { min: '0', max: String(max), maxScale: scale, allowZero: false })); }
  catch { throw new CustomerApiError('INVALID_SETTING', `${field}必须是范围内的正数。`); }
}
function bytes(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): bigint | null {
  const amount = positive(value, field, max, 0); return amount == null ? null : BigInt(amount);
}
function boolean(value: unknown, field: string) { if (typeof value !== 'boolean') throw new CustomerApiError('INVALID_SETTING', `${field}无效。`); return value; }
function list(value: unknown, permitted: readonly string[], field: string) {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !permitted.includes(v)) || new Set(value).size !== value.length) throw new CustomerApiError('INVALID_SETTING', `${field}无效。`);
  return value as string[];
}
function customerReady(c: ApiCustomer) {
  if (!c.license_confirmed || !c.read_enabled || !c.retention_policy?.trim() || !stringList(c.models_json).length
    || ![c.points_per_cny, c.max_task_points, c.daily_points, c.monthly_points, c.concurrency_limit, c.storage_limit_bytes, c.upload_limit_bytes].every(v => v != null && v > 0)) throw new CustomerApiError('CONFIGURATION_REQUIRED', '开通前需完成许可、售价、额度及媒体保留规则。', 409);
}
async function adminFresh(tx: ApiTx, actorId: string) {
  const actor = await tx.user.findUnique({ where: { id: actorId } });
  if (!actor || actor.role !== 'admin' || actor.account_type !== 'internal' || actor.status !== 'active'
    || actor.expires_at && actor.expires_at <= new Date()) throw new CustomerApiError('ADMIN_REQUIRED', '管理员身份已失效。', 403);
}

export async function mutateApiAdmin(actorId: string, body: Record<string, unknown>) {
  const operation = requestId(body.operation_id), receiptKey = `customer_api_admin:${digest(actorId)}:${digest(operation)}`;
  const fingerprint = digest(JSON.stringify(body));
  return prisma.$transaction(async tx => {
    await adminFresh(tx, actorId);
    const existing = await tx.platformSetting.findUnique({ where: { key: receiptKey } });
    if (existing) {
      const receipt = JSON.parse(existing.value_json);
      if (receipt.fingerprint !== fingerprint) throw new CustomerApiError('OPERATION_CONFLICT', '原操作号内容不一致。', 409);
      return { ...receipt.result, replayed: true };
    }
    let result: Record<string, unknown>;
    let token: string | undefined;
    if (body.action === 'create') {
      const name = text(body.name, '客户名称'), timezone = text(body.timezone, '预算时区'); budgetPeriod(timezone);
      const suffix = randomUUID().replace(/-/g, ''), username = `api_${suffix}`;
      const password = hashPassword(randomBytes(32).toString('base64url'));
      const user = await tx.user.create({ data: { name, username, email: `${username}@api.invalid`,
        password_hash: maintainAccountSessionBinding({ id: '', password_hash: '', role: 'user', account_type: 'external' },
          { id: '', password_hash: '', role: 'user', account_type: 'external', feature_profile_id: 'external_limited' }, password),
        role: 'user', account_type: 'external', feature_profile_id: 'external_limited', user_profile: 'other', status: 'active' } });
      await tx.creditAccount.create({ data: { user_id: user.id, balance: 0, frozen_credits: 0 } });
      const project = await tx.project.create({ data: { name: `${name} API`, type: 'personal', visibility: 'private', owner_user_id: user.id, created_by: user.id } });
      const card = await tx.videoCard.create({ data: { project_id: project.id, title: 'API 视频', owner_user_id: user.id, created_by: user.id } });
      const customer = await tx.apiCustomer.create({ data: { name, user_id: user.id, project_id: project.id, video_card_id: card.id, timezone } });
      result = { customer_id: customer.id };
    } else if (body.action === 'global') {
      const current = await tx.apiConfiguration.findUnique({ where: { id: 'global' } });
      if ((current?.revision ?? 0) !== body.revision) throw new CustomerApiError('VERSION_CONFLICT', '全局设置已更新，请重新读取后再保存。', 409);
      const data = { enabled: boolean(body.enabled, '启用状态'), license_confirmed: boolean(body.license_confirmed, '许可状态'),
        concurrency_limit: positive(body.concurrency_limit, '全局并发', 1000, 0), storage_limit_bytes: bytes(body.storage_limit_bytes, '全局容量'),
        max_output_bytes: bytes(body.max_output_bytes, '单任务成品上限', 200 * 1024 * 1024) };
      if (data.enabled && (!data.license_confirmed || !data.concurrency_limit || !data.storage_limit_bytes || !data.max_output_bytes
        || !current?.enabled && body.confirm_enable !== true)) throw new CustomerApiError('ENABLE_CONFIRMATION', '启用前需确认许可、并发与容量配置。', 409);
      if (current) {
        const changed = await tx.apiConfiguration.updateMany({ where: { id: 'global', revision: current.revision }, data: { ...data, revision: { increment: 1 } } });
        if (!changed.count) throw new CustomerApiError('VERSION_CONFLICT', '全局设置已更新。', 409);
      } else await tx.apiConfiguration.create({ data: { id: 'global', ...data } });
      result = { saved: true };
    } else {
      const id = text(body.customer_id, '客户编号'), customer = await tx.apiCustomer.findUnique({ where: { id } });
      if (!customer) throw new CustomerApiError('CUSTOMER_NOT_FOUND', '客户不存在。', 404);
      if (customer.revision !== body.revision) throw new CustomerApiError('VERSION_CONFLICT', '客户设置已更新；当前输入已保留，请重新核对。', 409);
      if (body.action === 'save') {
        const models = list(body.models, [PUBLIC_IP_MODEL], '模型范围');
        const data = { name: text(body.name, '客户名称'), models_json: JSON.stringify(models),
          create_enabled: boolean(body.create_enabled, '新建状态'), read_enabled: boolean(body.read_enabled, '读取状态'),
          license_confirmed: boolean(body.license_confirmed, '许可状态'),
          points_per_cny: positive(body.points_per_cny, '点/元', 10000), max_task_points: positive(body.max_task_points, '单笔上限'),
          daily_points: positive(body.daily_points, '日预算'), monthly_points: positive(body.monthly_points, '月预算'),
          concurrency_limit: positive(body.concurrency_limit, '客户并发', 1000, 0), storage_limit_bytes: bytes(body.storage_limit_bytes, '客户容量'),
          upload_limit_bytes: bytes(body.upload_limit_bytes, '上传上限', 200 * 1024 * 1024),
          retention_policy: body.retention_policy == null || body.retention_policy === '' ? null : text(body.retention_policy, '媒体保留规则', 1000) };
        if (data.create_enabled) {
          customerReady({ ...customer, ...data });
          if (!customer.create_enabled && body.confirm_enable !== true) throw new CustomerApiError('ENABLE_CONFIRMATION', '请确认此客户的售价和额度后启用。', 409);
        }
        if (!Array.isArray(body.rates) || body.rates.length !== 3) throw new CustomerApiError('INVALID_SETTING', '请提交完整三档规格费率。');
        const seen = new Set<string>(); let enabledRates = 0;
        for (const raw of body.rates) {
          if (!raw || typeof raw !== 'object') throw new CustomerApiError('INVALID_SETTING', '费率无效。');
          const rate = raw as Record<string, unknown>, resolution = text(rate.resolution, '分辨率');
          if (!['480p', '720p', '1080p'].includes(resolution) || seen.has(resolution)) throw new CustomerApiError('INVALID_SETTING', '费率规格无效。');
          seen.add(resolution);
          const amount = positive(rate.cny_per_second, '人民币/秒', 1_000_000, 8), enabled = boolean(rate.enabled, '费率状态');
          if (enabled && !amount) throw new CustomerApiError('PRICE_REQUIRED', '启用规格必须设置明确售价。');
          if (enabled) enabledRates++;
          const old = await tx.apiRate.findUnique({ where: { customer_id_model_resolution: { customer_id: id, model: PUBLIC_IP_MODEL, resolution } } });
          if (amount) await tx.apiRate.upsert({ where: { customer_id_model_resolution: { customer_id: id, model: PUBLIC_IP_MODEL, resolution } },
            create: { customer_id: id, model: PUBLIC_IP_MODEL, resolution, cny_per_second: amount, enabled }, update: { cny_per_second: amount, enabled, revision: { increment: 1 } } });
          else if (old) await tx.apiRate.update({ where: { id: old.id }, data: { enabled: false, revision: { increment: 1 } } });
        }
        if (data.create_enabled && !enabledRates) throw new CustomerApiError('PRICE_REQUIRED', '至少启用一个有明确售价的规格。', 409);
        const changed = await tx.apiCustomer.updateMany({ where: { id, revision: customer.revision }, data: { ...data, revision: { increment: 1 } } });
        if (!changed.count) throw new CustomerApiError('VERSION_CONFLICT', '客户设置已更新。', 409);
        result = { customer_id: id, saved: true };
      } else if (body.action === 'issue_key') {
        customerReady(customer);
        if (!customer.create_enabled) throw new CustomerApiError('CREATION_DISABLED', '先完成此客户配置并显式启用。', 409);
        const global = await tx.apiConfiguration.findUnique({ where: { id: 'global' } });
        if (!global?.enabled || !global.license_confirmed) throw new CustomerApiError('CREATION_DISABLED', '全局客户 API 尚未开放。', 409);
        const scopes = list(body.scopes, API_SCOPES, 'Key 权限'), models = list(body.models, stringList(customer.models_json), 'Key 型号');
        const expires = new Date(text(body.expires_at, '有效期'));
        if (!Number.isFinite(expires.getTime()) || expires <= new Date() || !scopes.length || !models.length) throw new CustomerApiError('INVALID_SETTING', '有效期、权限或型号范围无效。');
        const rate = positive(body.requests_per_minute, '每分钟请求数', 10000, 0);
        if (!rate) throw new CustomerApiError('INVALID_SETTING', '需要每分钟请求数。');
        if (await tx.apiKey.count({ where: { customer_id: id, active: true } }) >= 100) throw new CustomerApiError('KEY_LIMIT', '请先吊销不再使用的 Key。', 409);
        const generated = newApiKey(); token = generated.token;
        const key = await tx.apiKey.create({ data: { customer_id: id, name: text(body.name, 'Key 名称'), digest: generated.digest, prefix: generated.prefix,
          expires_at: expires, scopes_json: JSON.stringify(scopes), models_json: JSON.stringify(models), requests_per_minute: rate } });
        result = { customer_id: id, key_id: key.id, prefix: key.prefix, issued: true };
      } else if (body.action === 'revoke_key') {
        const keyId = text(body.key_id, 'Key 编号');
        if (body.confirm_revoke !== true) throw new CustomerApiError('REVOKE_CONFIRMATION', '请确认后续访问失效且在途任务仍继续计费。', 409);
        const changed = await tx.apiKey.updateMany({ where: { id: keyId, customer_id: id }, data: { active: false } });
        if (!changed.count) throw new CustomerApiError('KEY_NOT_FOUND', 'Key 不存在。', 404);
        result = { customer_id: id, key_id: keyId, revoked: true };
      } else throw new CustomerApiError('INVALID_ACTION', '管理操作无效。');
    }
    await tx.operationLog.create({ data: { operator_id: actorId, action: `customer_api_${body.action}`, target_type: 'ApiCustomer',
      target_id: typeof result.customer_id === 'string' ? result.customer_id : 'global', detail: JSON.stringify(result) } });
    await tx.platformSetting.create({ data: { key: receiptKey, value_json: JSON.stringify({ fingerprint, result }), updated_by: actorId } });
    return { ...result, ...(token ? { token } : {}) };
  });
}
