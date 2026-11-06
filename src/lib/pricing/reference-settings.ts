import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { PRICING_POLICY_KEY } from './admin-contract';
import { getAdminPricingSnapshot, PricingAdminServiceError } from './policy';
import { pricingFingerprint } from './catalog';
import type { PricingPolicy } from './types';
import { getDefaultReferenceSettings, parseReferenceSettings, REFERENCE_PRICING_KEY,
  type ReferencePricingOperation, type ReferencePricingSettings, type ReferencePricingSnapshot } from './reference-contract';

export { getDefaultReferenceSettings, parseReferenceSettings } from './reference-contract';

type Db = Prisma.TransactionClient;
type Actor = { id: string };
const action = 'usage_reference_pricing_save';

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new PricingAdminServiceError('保存请求编号无效');
  return value;
}
function receiptId(actor: Actor, id: string) {
  return `reference-pricing:${createHash('sha256').update(JSON.stringify([actor.id, id])).digest('hex')}`;
}
async function freshAdmin(actor: Actor, db: Db) {
  const user = await db.user.findUnique({ where: { id: actor.id }, select: { role: true, status: true, expires_at: true } });
  if (!user || user.role !== 'admin' || user.status !== 'active' || user.expires_at && user.expires_at <= new Date()) {
    throw new AuthError('管理员权限已失效', 403);
  }
}
async function receipt(actor: Actor, id: string, db: Db): Promise<{ fingerprint: string; operation: ReferencePricingOperation } | null> {
  const row = await db.operationLog.findUnique({ where: { id: receiptId(actor, id) } });
  if (!row) return null;
  try {
    const value = JSON.parse(row.detail || '');
    if (row.operator_id !== actor.id || row.action !== action || row.target_type !== 'PlatformSetting'
      || row.target_id !== REFERENCE_PRICING_KEY || typeof value.fingerprint !== 'string'
      || value.operation?.requestId !== id || !['succeeded', 'rejected'].includes(value.operation?.state)
      || value.operation.error !== null && typeof value.operation.error !== 'string') throw new Error('invalid receipt');
    const operation: ReferencePricingOperation = { ...value.operation,
      settings: value.operation.state === 'succeeded' ? parseReferenceSettings(value.operation.settings) : null };
    return { fingerprint: value.fingerprint, operation };
  } catch { throw new PricingAdminServiceError('原保存回执无法读取，请保留草稿和原请求编号', 503, 'reference_receipt_invalid'); }
}
async function writeReceipt(actor: Actor, id: string, fingerprint: string, operation: ReferencePricingOperation, db: Db) {
  await db.operationLog.create({ data: { id: receiptId(actor, id), operator_id: actor.id, action,
    target_type: 'PlatformSetting', target_id: REFERENCE_PRICING_KEY, detail: JSON.stringify({ fingerprint, operation }) } });
}

async function readSnapshot(actor: Actor, db: Db) {
  // Reuse the validated policy/catalog reader rather than inventing another policy parser.
  const pricing = await getAdminPricingSnapshot(actor, db);
  const storedPolicy = await db.platformSetting.findUnique({ where: { key: PRICING_POLICY_KEY } });
  const policy: PricingPolicy = storedPolicy ? JSON.parse(storedPolicy.value_json)
    : { schemaVersion: 1, revision: pricing.revision, standards: pricing.standards, rules: [] };
  const confirmedIds = new Set(pricing.rows.filter(row => row.enabled && row.availability === 'ready'
    && ['confirmed', 'not_applicable'].includes(row.confirmation)).map(row => row.id));
  const confirmedPolicy = { ...policy, rules: policy.rules.filter(rule => confirmedIds.has(rule.id)) };
  const referencePolicy = getDefaultReferenceSettings(confirmedPolicy);
  const pointsPerCny = pricing.authoring?.globalPointsPerCny ?? pricing.standards.site_base_cny;
  const usable = confirmedPolicy.rules.filter(rule => rule.identity.billingMode === 'fixed'
    && (rule.mode === 'free' || ['follow', 'custom'].includes(rule.mode) && rule.baseCny !== null && !!rule.source?.confirmedAt));
  const rules: ReferencePricingSnapshot['rules'] = usable.map(rule => {
    const row = pricing.rows.find(item => item.id === rule.id)!;
    return { id: rule.id, label: `${row.label} · ${row.providerLabel}${Object.values(rule.identity.specifications).length ? ` · ${Object.values(rule.identity.specifications).join(' / ')}` : ''}`,
      kind: rule.identity.kind, model: rule.identity.modelId, unit: rule.identity.unit, baseCny: rule.mode === 'free' ? '0' : rule.baseCny!,
      pointsPerCny: rule.mode === 'custom' ? rule.customPointsPerCny
        : rule.mode === 'follow' ? policy.standards[rule.basisKind] : null,
      ...(row.rounding ? { rounding: row.rounding } : {}) };
  });
  const stored = await db.platformSetting.findUnique({ where: { key: REFERENCE_PRICING_KEY } });
  let settings: ReferencePricingSettings;
  try { settings = stored ? parseReferenceSettings(stored.value_json) : referencePolicy; }
  catch { throw new PricingAdminServiceError('历史参考标价配置损坏，未按默认值覆盖', 503, 'reference_settings_invalid'); }
  const snapshot: ReferencePricingSnapshot = { settings, rules, policyRevision: pricing.revision,
    pointsPerCny };
  return { snapshot, raw: stored?.value_json ?? null };
}

export async function getReferencePricingSettings(actor: Actor): Promise<ReferencePricingSnapshot> {
  return prisma.$transaction(async db => (await readSnapshot(actor, db)).snapshot, { maxWait: 10000, timeout: 30000 });
}
export async function getReferencePricingOperation(actor: Actor, value: unknown): Promise<{ operation: ReferencePricingOperation }> {
  const id = requestId(value);
  return prisma.$transaction(async db => {
    await freshAdmin(actor, db);
    return { operation: (await receipt(actor, id, db))?.operation ?? { requestId: id, state: 'unknown', settings: null, error: null } };
  }, { maxWait: 10000, timeout: 10000 });
}

export async function saveReferencePricingSettings(actor: Actor, input: unknown): Promise<{ operation: ReferencePricingOperation } & Partial<ReferencePricingSnapshot>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PricingAdminServiceError('保存内容无效');
  const body = input as Record<string, unknown>, id = requestId(body.requestId), fingerprint = pricingFingerprint(body);
  const replay = async (db: Db) => {
    const previous = await receipt(actor, id, db);
    if (previous && previous.fingerprint !== fingerprint) throw new PricingAdminServiceError('同一保存编号内容不同，请只查询原操作', 409, 'reference_operation_mismatch');
    return previous?.operation;
  };
  try {
    return await prisma.$transaction(async db => {
      await freshAdmin(actor, db);
      const previous = await replay(db);
      if (previous) return { operation: previous };
      if (Object.keys(body).some(key => !['revision', 'requestId', 'settings'].includes(key))) throw new PricingAdminServiceError('保存内容包含未知字段');
      let settings: ReferencePricingSettings;
      try { settings = parseReferenceSettings(body.settings); }
      catch (error) { throw new PricingAdminServiceError(error instanceof Error ? error.message : '历史参考标价无效'); }
      const { snapshot, raw } = await readSnapshot(actor, db);
      if (body.revision !== snapshot.settings.revision || settings.revision !== body.revision) {
        throw new PricingAdminServiceError('历史参考标价已更新，草稿已保留，请重新读取当前版本', 409, 'reference_conflict');
      }
      const assertRule = (kind: string, ruleId: string, unit?: string) => {
        if (!snapshot.rules.some(rule => rule.id === ruleId && rule.kind === kind && (!unit || rule.unit === unit))) {
          throw new PricingAdminServiceError('引用规则已失效或类型、单位不符，请重新选择');
        }
      };
      for (const [kind, choice] of Object.entries(settings.defaults)) if (choice.ruleId) assertRule(kind, choice.ruleId, choice.unit);
      for (const mapping of settings.models) assertRule(mapping.kind, mapping.ruleId);
      settings.revision = randomUUID();
      const data = { value_json: JSON.stringify(settings), updated_by: actor.id };
      if (raw !== null) {
        const swapped = await db.platformSetting.updateMany({ where: { key: REFERENCE_PRICING_KEY, value_json: raw }, data });
        if (swapped.count !== 1) throw new PricingAdminServiceError('另一个保存已先完成，草稿已保留', 409, 'reference_conflict');
      } else await db.platformSetting.create({ data: { key: REFERENCE_PRICING_KEY, ...data } });
      const operation: ReferencePricingOperation = { requestId: id, state: 'succeeded', settings, error: null };
      await writeReceipt(actor, id, fingerprint, operation, db);
      return { ...snapshot, settings, operation };
    }, { maxWait: 10000, timeout: 30000 });
  } catch (error) {
    const rolledBack = error instanceof Prisma.PrismaClientKnownRequestError;
    const failure = error instanceof PricingAdminServiceError ? error
      : rolledBack && ['P2002', 'P2034'].includes(error.code) ? new PricingAdminServiceError('另一个保存已先完成，本次未生效，请重新读取', 409, 'reference_conflict') : null;
    if (!failure || failure.code === 'reference_operation_mismatch' || failure.status >= 500) throw error;
    // Only known rollbacks get a durable rejection; uncertain failures remain GET-only.
    return prisma.$transaction(async db => {
      await freshAdmin(actor, db);
      const previous = await replay(db);
      if (previous) return { operation: previous };
      const operation: ReferencePricingOperation = { requestId: id, state: 'rejected', settings: null, error: failure.message };
      await writeReceipt(actor, id, fingerprint, operation, db);
      return { operation };
    }, { maxWait: 10000, timeout: 10000 });
  }
}
