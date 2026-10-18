import { prisma } from '@/lib/prisma';
import { getMuskApiSettings, isMuskApiReady, type MuskApiSettings } from '@/lib/integrations/musk';
import { isStudioTextModel } from '@/lib/template-studio/text-models';
import type { RoleDb } from './permissions';
import { record, RoleError, type RoleGrant } from './types';
import { TEXT_BILLING_KEY, textScope } from './text-provider';

export const ROLE_TEXT_POINTS_PER_USD = 35 as const;
export const ROLE_TEXT_RISK_NOTICE_VERSION = 'role-text-unpriced.v1';
export type RoleTextPolicy = {
  version: 'role-text-policy.v2'; enabled: boolean; scope: string; allowedModels: string[];
  allowUnpricedText: boolean; maxInputBytes: number; maxOutputTokens: number; revision: number;
  consent: { actorId: string; at: string; riskNoticeVersion: string } | null;
};
export type TextContractV2 = {
  version: 'role-text.v2'; billingMode: 'actual_with_authorized_reserve'; reserveBasis: 'user_authorization';
  scope: string; model: string; policyRevision: number; grantId: string; pointsPerUsd: 35;
  reserveUsdMicros: number; reservePointCents: number; maxInputBytes: number; maxOutputTokens: number;
  expiresAt: string; receiptSource: 'header_request_id'; receiptValidation: 'per_attempt'; quoteEvidence: null;
};
const safePositive = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;

export function reserveRolePointCents(micros: number): number {
  if (!safePositive(micros, 1_000_000_000)) throw new RoleError('文字预留额度无效', 409, 'billing_conflict');
  return Number((BigInt(micros) * BigInt(ROLE_TEXT_POINTS_PER_USD) + BigInt(9999)) / BigInt(10000));
}

export function parseRoleTextPolicy(raw: unknown, scope: string): RoleTextPolicy | null {
  if (!record(raw) || Object.keys(raw).some(key => !['version', 'enabled', 'scope', 'allowedModels', 'allowUnpricedText', 'maxInputBytes', 'maxOutputTokens', 'revision', 'consent'].includes(key))
    || raw.version !== 'role-text-policy.v2' || raw.scope !== scope || !/^[a-f0-9]{64}$/.test(scope)
    || typeof raw.enabled !== 'boolean' || typeof raw.allowUnpricedText !== 'boolean'
    || !Array.isArray(raw.allowedModels) || !raw.allowedModels.length || raw.allowedModels.length > 20
    || raw.allowedModels.some(model => !isStudioTextModel(model)) || new Set(raw.allowedModels).size !== raw.allowedModels.length
    || !safePositive(raw.revision, 1_000_000_000) || !safePositive(raw.maxInputBytes, 128 * 1024)
    || !safePositive(raw.maxOutputTokens, 4096)) return null;
  if (raw.consent !== null && (!record(raw.consent)
    || Object.keys(raw.consent).some(key => !['actorId', 'at', 'riskNoticeVersion'].includes(key))
    || typeof raw.consent.actorId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(raw.consent.actorId)
    || typeof raw.consent.at !== 'string' || !Number.isFinite(Date.parse(raw.consent.at))
    || Date.parse(raw.consent.at) > Date.now() || raw.consent.riskNoticeVersion !== ROLE_TEXT_RISK_NOTICE_VERSION)) return null;
  if (raw.enabled && (!raw.allowUnpricedText || !raw.consent)) return null;
  return raw as RoleTextPolicy;
}

export async function readRoleTextPolicy(db: RoleDb, settings: MuskApiSettings): Promise<RoleTextPolicy | null> {
  const row = await db.platformSetting.findUnique({ where: { key: TEXT_BILLING_KEY }, select: { value_json: true } });
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.value_json);
    return record(value) ? parseRoleTextPolicy(value.policy, textScope(settings)) : null;
  } catch { return null; }
}

export function parseV2TextContract(raw: unknown, scope: string, model: string): TextContractV2 | null {
  if (!record(raw) || Object.keys(raw).some(key => !['version', 'billingMode', 'reserveBasis', 'scope', 'model', 'policyRevision', 'grantId', 'pointsPerUsd', 'reserveUsdMicros', 'reservePointCents', 'maxInputBytes', 'maxOutputTokens', 'expiresAt', 'receiptSource', 'receiptValidation', 'quoteEvidence'].includes(key))
    || raw.version !== 'role-text.v2' || raw.billingMode !== 'actual_with_authorized_reserve'
    || raw.reserveBasis !== 'user_authorization' || raw.scope !== scope || !/^[a-f0-9]{64}$/.test(scope)
    || raw.model !== model || !isStudioTextModel(model) || raw.pointsPerUsd !== ROLE_TEXT_POINTS_PER_USD
    || raw.receiptSource !== 'header_request_id' || raw.receiptValidation !== 'per_attempt' || raw.quoteEvidence !== null
    || !safePositive(raw.policyRevision, 1_000_000_000) || typeof raw.grantId !== 'string'
    || !/^[A-Za-z0-9_-]{1,160}$/.test(raw.grantId) || !safePositive(raw.reserveUsdMicros, 1_000_000_000)
    || !safePositive(raw.reservePointCents, 1_000_000_000) || !safePositive(raw.maxInputBytes, 128 * 1024)
    || !safePositive(raw.maxOutputTokens, 4096) || typeof raw.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(raw.expiresAt)) || Date.parse(raw.expiresAt) <= Date.now()) return null;
  if (raw.reservePointCents !== reserveRolePointCents(Number(raw.reserveUsdMicros))) return null;
  return raw as TextContractV2;
}

export function createRoleTextContract(policy: RoleTextPolicy, grant: RoleGrant, grantId: string, model: string): TextContractV2 {
  if (!parseRoleTextPolicy(policy, policy.scope) || !policy.enabled || !policy.allowUnpricedText || !policy.allowedModels.includes(model)
    || grant.schema !== 'role.authorization.v2' || grant.scope !== policy.scope || grant.policyRevision !== policy.revision
    || grant.pointsPerUsd !== ROLE_TEXT_POINTS_PER_USD || !grant.executors.some(executor => executor.model === model)
    || grant.maxInputBytes > policy.maxInputBytes || grant.maxOutputTokens > policy.maxOutputTokens
    || grant.reserveUsdMicros > grant.usdMicrosLimit || grant.reservePointCents > grant.pointLimit) {
    throw new RoleError('角色文字政策或任务授权已变化，请重新确认范围与额度', 409, 'text_authorization_changed');
  }
  const contract: TextContractV2 = { version: 'role-text.v2', billingMode: 'actual_with_authorized_reserve',
    reserveBasis: 'user_authorization', scope: policy.scope, model, policyRevision: policy.revision, grantId,
    pointsPerUsd: ROLE_TEXT_POINTS_PER_USD, reserveUsdMicros: grant.reserveUsdMicros, reservePointCents: grant.reservePointCents,
    maxInputBytes: grant.maxInputBytes, maxOutputTokens: grant.maxOutputTokens, expiresAt: grant.expiresAt,
    receiptSource: 'header_request_id', receiptValidation: 'per_attempt', quoteEvidence: null };
  if (!parseV2TextContract(contract, policy.scope, model)) throw new RoleError('文字授权合同无效', 409, 'billing_conflict');
  return contract;
}

export async function roleTextReadiness(db: RoleDb = prisma): Promise<{ enabled: boolean; code: string; reason: string; pointsPerUsd: 35 }> {
  const settings = await getMuskApiSettings(db);
  const policy = await readRoleTextPolicy(db, settings);
  let code = 'ready', reason = '按原账单扣点，预留不是报价；费用待核对或超额时暂停。';
  if (!isMuskApiReady(settings) || new URL(settings.base_url).origin !== 'https://api.muskapis.com') {
    code = 'text_provider_unavailable'; reason = '文字接口未就绪，请管理员检查原文字设置。';
  } else if (!policy) {
    code = 'role_text_policy_pending'; reason = '角色文字尚未配置或原同意已失效，请管理员保存角色文字设置。';
  } else if (!policy.enabled || !policy.allowUnpricedText) {
    code = 'role_text_policy_disabled'; reason = '角色文字当前关闭，请管理员确认风险后启用；普通文字功能不受影响。';
  }
  return { enabled: code === 'ready', code, reason, pointsPerUsd: ROLE_TEXT_POINTS_PER_USD };
}
