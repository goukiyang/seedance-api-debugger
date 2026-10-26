import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { PricingItemUnavailableError } from './item-unavailable';
import { isSeedanceVideoDuration } from '@/lib/provider/seedance-models';
import { assertPricingImageConsumerReady, pricingImageConsumerState } from './runtime';
import { normalizeDecimal, multiplyDecimal, subtractDecimal, roundDecimal, compareDecimal, divideDecimal, PricingNumberError } from './math';
import { selectPricingRule, assertNoRuleAmbiguity, PricingRuleConflict } from './resolve';
import { getPricingCatalog, appendPricingCatalogScopes, pricingCatalogRowId, assertPricingCatalogIdentity, pricingCanonical, pricingFingerprint, type PricingCatalog,
  type PricingCatalogBinding, type PricingClient } from './catalog';
import { PRICING_ADMIN_SCHEMA, PRICING_POLICY_KEY, PRICING_REVISION_PREFIX, PRICING_OPERATION_PREFIX,
  PRICING_UNCONFIGURED_REVISION, PRICING_ADMIN_LIMITS,
  type PricingAdminActor, type PricingAdminBasis, type PricingAdminRow, type PricingAdminIdentity,
  type PricingAdminAction, type PricingAdminPreviewInput, type PricingAdminPreview, type PricingAdminSaveInput,
  type PricingAdminOperation, type PricingAdminSnapshot, type PricingAdminHistory, type PricingAdminHistoryEntry,
  type PricingAdminFilter, type PricingAdminPriceView, type PricingAdminRowChange,
  type PricingAdminSourceInput, type PricingAdminSource, type PricingAdminExchangeInput,
  type PricingAdminSimulation, type PricingAdminExchange } from './admin-contract';
import { PRICING_AUTHORING_KEY, type PricingAuthoring, type PricingEnhanceGroup } from './pricing-authoring-contract';
import { filterPricingAdminRows } from './admin-client-state';
import { pricingDisplayName } from './admin-display';
import { emptyPricingAuthoring, parsePricingAuthoring, pricingAuthoringContent, projectPricingAuthoring,
  newPricingAuthoringEntry, derivedPricingBase, assertPricingBaseRelation } from './pricing-authoring';

type Actor = Pick<PricingAdminActor, 'id'>;
type Standards = Record<PricingAdminBasis, string | null>;
type StoredRule = {
  id: string; identity: PricingAdminIdentity; mode: PricingAdminRow['mode']; basisKind: PricingAdminBasis;
  baseCny: string | null; source: PricingAdminSource | null; exchangeRate: PricingAdminExchange | null;
  customPointsPerCny: string | null; binding: PricingCatalogBinding;
  legacyUnitCredits: string | null; legacyRounding: PricingAdminRow['legacyRounding'];
  legacyPointsPerUsd: string | null; updatedAt: string;
};
type Policy = { schemaVersion: 1; revision: string; standards: Standards; rules: StoredRule[];
  updatedAt: string | null; updatedBy: PricingAdminActor | null };
type Revision = { schemaVersion: 1; policy: Policy; authoring?: PricingAuthoring; history: PricingAdminHistoryEntry;
  rows: PricingAdminRow[]; bindings: Record<string, PricingCatalogBinding> };
type Receipt = { schemaVersion: 1; actorId: string; requestFingerprint: string; result: PricingAdminOperation };
type State = { policy: Policy; raw: string | null; catalog: PricingCatalog; rows: PricingAdminRow[]; authoring: PricingAuthoring; authoringRaw: string | null };
type Prepared = { input: PricingAdminPreviewInput; next: Policy; rows: PricingAdminRow[];
  affected: string[]; changes: PricingAdminPreview['changes']; skipped: PricingAdminPreview['skipped'];
  simulation: PricingAdminSimulation | null; scenarios: PricingAdminSimulation[]; authoring: PricingAuthoring; authoringChanged: boolean; inputFingerprint: string; confirmationTime: string };

export class PricingAdminServiceError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'pricing_invalid',
    public readonly fields?: Record<string, string>, public readonly currentRevision?: string) { super(message); }
}
function fail(message: string, code = 'pricing_invalid'): never { throw new PricingAdminServiceError(message, 400, code); }
function corrupt(): never { throw new PricingAdminServiceError('费率配置损坏或版本不兼容，未按空配置覆盖', 503, 'pricing_policy_invalid'); }
function conflict(revision?: string): never { throw new PricingAdminServiceError('费率或来源配置已变化，请保留草稿重新预览', 409, 'pricing_conflict', undefined, revision); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('请求包含未知字段或无效对象');
}
function textValue(value: unknown, max = 2000, nonempty = true): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail('文字字段为空、过长或包含控制字符');
  return value;
}
function isBasis(value: unknown): value is PricingAdminBasis { return value === 'site_base_cny' || value === 'supplier_cost_cny'; }
function basis(value: unknown): PricingAdminBasis { if (!isBasis(value)) fail('计价依据无效'); return value; }
function decimal(value: unknown, options: Parameters<typeof normalizeDecimal>[1] = {}) {
  try { return normalizeDecimal(value, options); }
  catch (error) { throw new PricingAdminServiceError(error instanceof Error ? error.message : '数字格式无效', 400, 'pricing_number_invalid'); }
}
function rate(value: unknown) { return decimal(value, { maxScale: 1, min: PRICING_ADMIN_LIMITS.rateMin,
  max: PRICING_ADMIN_LIMITS.rateMax, allowZero: false, maxLength: 32 }); }
function baseAmount(value: unknown) { return decimal(value, { maxScale: 8, max: PRICING_ADMIN_LIMITS.baseMax, allowZero: false, maxLength: 32 }); }
function uniqueIds(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > PRICING_ADMIN_LIMITS.maxChanges || (!allowEmpty && !value.length)) fail('请选择有效范围，单次最多 2000 项');
  const ids = value.map(item => textValue(item, 160));
  if (new Set(ids).size !== ids.length) fail('收费项不能重复选择');
  return ids;
}
function sourceInput(value: unknown): PricingAdminSourceInput {
  keys(value, ['type', 'reference', 'note']);
  if (!['admin_defined', 'document', 'supplier_statement', 'existing_contract'].includes(String(value.type))) fail('请选择真实来源类型');
  return { type: value.type as PricingAdminSourceInput['type'], reference: textValue(value.reference), note: textValue(value.note, 2000, false) };
}
function exchangeInput(value: unknown): PricingAdminExchangeInput {
  keys(value, ['sourceCurrency', 'targetCurrency', 'direction', 'rate', 'effectiveFrom', 'source']);
  if (!['USD', 'CNY'].includes(String(value.sourceCurrency)) || value.targetCurrency !== 'CNY' || value.direction !== 'CNY_per_source_unit') fail('仅支持已定义方向的 USD/CNY 换算');
  const normalized = decimal(value.rate, { min: PRICING_ADMIN_LIMITS.exchangeMin, max: PRICING_ADMIN_LIMITS.exchangeMax, maxScale: 8, allowZero: false });
  if (value.sourceCurrency === 'CNY' && compareDecimal(normalized, '1') !== 0) fail('人民币同币种换算率必须为 1');
  const time = textValue(value.effectiveFrom, 40);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(time) || !Number.isFinite(Date.parse(time))) fail('请提供含时区的准确生效时间');
  return { sourceCurrency: value.sourceCurrency as 'USD' | 'CNY', targetCurrency: 'CNY', direction: 'CNY_per_source_unit',
    rate: normalized, effectiveFrom: new Date(time).toISOString(), source: sourceInput(value.source) };
}
function rowChange(value: unknown): PricingAdminRowChange {
  keys(value, ['id', 'mode', 'customPointsPerCny', 'basisKind', 'base', 'exchangeRate', 'specifications', 'authoringRateMode', 'baseRelation', 'evidence']);
  const result: PricingAdminRowChange = { id: textValue(value.id, 160) };
  if (value.specifications !== undefined) {
    keys(value.specifications, ['quality', 'resolution', 'ratio', 'referenceVideo', 'pricingPurpose']);
    result.specifications = Object.fromEntries(Object.entries(value.specifications).map(([key, item]) => [key, textValue(item, 64)]));
  }
  if (value.authoringRateMode !== undefined) {
    if (!['follow_global', 'custom'].includes(String(value.authoringRateMode))) fail('统一跟随方式无效');
    result.authoringRateMode = value.authoringRateMode as 'follow_global' | 'custom';
  }
  if (value.baseRelation !== undefined) {
    if (value.baseRelation === null) result.baseRelation = null;
    else { keys(value.baseRelation, ['parentId', 'factor']);
      if (value.baseRelation.factor !== '1.5') fail('基价系数只支持已确认的1.5');
      result.baseRelation = { parentId: textValue(value.baseRelation.parentId, 160), factor: '1.5' };
    }
  }
  if (value.base !== undefined && value.baseRelation !== undefined && value.baseRelation !== null) fail('不能同时手填子基价与恢复父价跟随，请保留其中一种');
  if (value.evidence !== undefined) {
    keys(value.evidence, ['kind', 'amount', 'currency', 'unit', 'specifications', 'sampledAt', 'exchangeAssumption', 'reference', 'version']);
    const candidate = { ...newPricingAuthoringEntry(), evidence: value.evidence };
    try { parsePricingAuthoring(JSON.stringify({ ...emptyPricingAuthoring('test'), entries: { test: candidate } }), 'test'); }
    catch { fail('价格参考证据无效'); }
    result.evidence = value.evidence as unknown as NonNullable<PricingAdminRowChange['evidence']>;
  }
  if (value.mode !== undefined) {
    if (!['follow', 'custom', 'free', 'legacy_fixed'].includes(String(value.mode))) fail('跟随方式无效');
    result.mode = value.mode as PricingAdminRowChange['mode'];
  }
  if (value.customPointsPerCny !== undefined) result.customPointsPerCny = rate(value.customPointsPerCny);
  if (value.basisKind !== undefined) result.basisKind = basis(value.basisKind);
  if (value.base !== undefined) {
    keys(value.base, ['amount', 'currency', 'unit', 'source']);
    if (value.base.currency !== 'CNY' || !['image', 'second'].includes(String(value.base.unit))) fail('基价币种或计量单位无效');
    result.base = { amount: baseAmount(value.base.amount), currency: 'CNY', unit: value.base.unit as 'image' | 'second', source: sourceInput(value.base.source) };
  }
  if (value.exchangeRate !== undefined) result.exchangeRate = exchangeInput(value.exchangeRate);
  if (Object.keys(result).length === 1) fail('收费项没有修改内容');
  return result;
}
function parsePreview(value: unknown, saving = false): PricingAdminPreviewInput {
  keys(value, ['expectedRevision', 'expectedAuthoringRevision', 'catalogFingerprint', 'action', 'simulation', 'scenarios', ...(saving ? ['operationId', 'previewToken'] : [])]);
  const expectedRevision = textValue(value.expectedRevision, 160), catalogFingerprint = textValue(value.catalogFingerprint, 64);
  if (!/^[a-f0-9]{64}$/.test(catalogFingerprint)) fail('目录凭证无效，请重新读取');
  if (!record(value.action)) fail('请选择保存、统一或恢复操作');
  let action: PricingAdminAction;
  if (value.action.kind === 'save') {
    keys(value.action, ['kind', 'changes']); keys(value.action.changes, ['standards', 'rows', 'authoring']);
    if (!Array.isArray(value.action.changes.rows) || value.action.changes.rows.length > PRICING_ADMIN_LIMITS.maxChanges) fail('单次最多修改 2000 项');
    const rows = value.action.changes.rows.map(rowChange);
    uniqueIds(rows.map(item => item.id), true);
    let standards: Partial<Record<PricingAdminBasis, string>> | undefined;
    if (value.action.changes.standards !== undefined) {
      keys(value.action.changes.standards, ['site_base_cny', 'supplier_cost_cny']); standards = {};
      for (const [name, amount] of Object.entries(value.action.changes.standards)) standards[basis(name)] = rate(amount);
    }
    let authoring;
    if (value.action.changes.authoring !== undefined) {
      keys(value.action.changes.authoring, ['globalPointsPerCny', 'enhanceGroup']);
      authoring = { ...(value.action.changes.authoring.globalPointsPerCny === undefined ? {} : { globalPointsPerCny: rate(value.action.changes.authoring.globalPointsPerCny) }),
        ...(value.action.changes.authoring.enhanceGroup === undefined ? {} : { enhanceGroup: value.action.changes.authoring.enhanceGroup as PricingEnhanceGroup }) };
      try { parsePricingAuthoring(JSON.stringify({ ...emptyPricingAuthoring('test'), ...authoring }), 'test'); }
      catch { fail('增强分组或统一标准无效'); }
    }
    action = { kind: 'save', changes: { rows, ...(standards ? { standards } : {}), ...(authoring ? { authoring } : {}) } };
  } else if (value.action.kind === 'unify') {
    keys(value.action, ['kind', 'basisKind', 'ruleIds']);
    action = { kind: 'unify', basisKind: basis(value.action.basisKind), ruleIds: uniqueIds(value.action.ruleIds) };
  } else if (value.action.kind === 'restore') {
    keys(value.action, ['kind', 'revisionId', 'ruleIds', 'standards']);
    const ruleIds = uniqueIds(value.action.ruleIds, true);
    const standards = value.action.standards === undefined ? undefined : uniqueIds(value.action.standards, true).map(basis);
    if (!ruleIds.length && !standards?.length) fail('请选择要恢复的收费项或标准');
    action = { kind: 'restore', revisionId: textValue(value.action.revisionId, 160), ruleIds, ...(standards ? { standards } : {}) };
  } else fail('不支持的费率操作');
  let simulation: PricingAdminPreviewInput['simulation'];
  if (value.simulation !== undefined) {
    keys(value.simulation, ['rowId', 'quantity', 'exampleAmount']);
    simulation = { rowId: textValue(value.simulation.rowId, 160), quantity: decimal(value.simulation.quantity,
      { maxScale: 8, allowZero: false, max: '10000000' }),
      ...(value.simulation.exampleAmount !== undefined ? { exampleAmount: decimal(value.simulation.exampleAmount, { maxScale: 6, max: '2000', allowZero: true }) } : {}) };
  }
  const scenarios: NonNullable<PricingAdminPreviewInput['scenarios']> = [];
  if (value.scenarios !== undefined) {
    if (!Array.isArray(value.scenarios) || value.scenarios.length > 2000) fail('场景试算最多2000项，未截断');
    for (const item of value.scenarios) {
      keys(item, ['rowId', 'quantity', 'exampleAmount']);
      scenarios.push({ rowId: textValue(item.rowId, 160), quantity: decimal(item.quantity, { maxScale: 8, allowZero: false, max: '10000000' }),
        ...(item.exampleAmount === undefined ? {} : { exampleAmount: decimal(item.exampleAmount, { maxScale: 6, max: '2000' }) }) });
    }
  }
  return { expectedRevision, catalogFingerprint, action, ...(value.expectedAuthoringRevision === undefined ? {} : { expectedAuthoringRevision: textValue(value.expectedAuthoringRevision, 160) }),
    ...(simulation ? { simulation } : {}), ...(value.scenarios === undefined ? {} : { scenarios }) };
}
async function freshActor(actor: Actor, client: PricingClient): Promise<PricingAdminActor> {
  if (!actor || typeof actor.id !== 'string') throw new AuthError('请先登录', 401);
  const user = await client.user.findUnique({ where: { id: actor.id }, select: { id: true, name: true, username: true,
    avatar_url: true, role: true, status: true, expires_at: true } });
  if (!user || user.role !== 'admin' || user.status !== 'active' || (user.expires_at && user.expires_at.getTime() <= Date.now())) throw new AuthError('管理员权限已失效，请重新确认账号', 403);
  return { id: user.id, displayName: user.name || user.username, avatarUrl: user.avatar_url || null };
}
function emptyPolicy(): Policy { return { schemaVersion: 1, revision: PRICING_UNCONFIGURED_REVISION,
  standards: { site_base_cny: null, supplier_cost_cny: null }, rules: [], updatedAt: null, updatedBy: null }; }
function validateStoredActor(value: unknown) {
  keys(value, ['id', 'displayName', 'avatarUrl']);
  textValue(value.id, 160); textValue(value.displayName, 500, false);
  if (value.avatarUrl !== null) textValue(value.avatarUrl, 4000, false);
}
function parsePolicy(raw: string): Policy {
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.schemaVersion !== 1 || typeof value.revision !== 'string' || !record(value.standards)
      || !Array.isArray(value.rules) || value.rules.length > PRICING_ADMIN_LIMITS.maxChanges || !record(value.updatedBy)
      || typeof value.updatedBy.id !== 'string' || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) corrupt();
    keys(value, ['schemaVersion', 'revision', 'standards', 'rules', 'updatedAt', 'updatedBy']);
    validateStoredActor(value.updatedBy);
    if (Object.keys(value.standards).length !== 2 || Object.keys(value.standards).some(name => !isBasis(name))) corrupt();
    for (const amount of Object.values(value.standards)) if (amount !== null) rate(amount);
    for (const rule of value.rules) {
      if (!record(rule) || typeof rule.id !== 'string' || !record(rule.identity) || !record(rule.identity.specifications)
        || !['video', 'image', 'enhance', 'h3'].includes(String(rule.identity.kind))
        || typeof rule.identity.channelId !== 'string' || typeof rule.identity.modelId !== 'string'
        || !['fixed', 'actual'].includes(String(rule.identity.billingMode)) || !['image', 'second'].includes(String(rule.identity.unit))
        || Object.values(rule.identity.specifications).some(item => typeof item !== 'string') || !isBasis(rule.basisKind)
        || !['follow', 'custom', 'free', 'legacy_fixed', 'legacy_actual'].includes(String(rule.mode))
        || !record(rule.binding) || ['configRevision', 'billingPrincipalId', 'credentialVersion', 'configFingerprint'].some(name => typeof (rule.binding as Record<string, unknown>)[name] !== 'string')) corrupt();
      keys(rule, ['id', 'identity', 'mode', 'basisKind', 'baseCny', 'source', 'exchangeRate', 'customPointsPerCny', 'binding',
        'legacyUnitCredits', 'legacyRounding', 'legacyPointsPerUsd', 'updatedAt']);
      keys(rule.identity, ['kind', 'channelId', 'modelId', 'billingMode', 'unit', 'specifications']);
      keys(rule.binding, ['configRevision', 'billingPrincipalId', 'credentialVersion', 'configFingerprint']);
      if (!Number.isFinite(Date.parse(String(rule.updatedAt))) || rule.identity.unit !== (rule.identity.kind === 'image' ? 'image' : 'second')
        || rule.identity.billingMode === 'actual' && rule.identity.kind !== 'image'
        || rule.basisKind !== (rule.identity.billingMode === 'actual' ? 'supplier_cost_cny' : 'site_base_cny')) corrupt();
      if (rule.customPointsPerCny !== null) rate(rule.customPointsPerCny);
      if (rule.baseCny !== null) baseAmount(rule.baseCny);
      if (rule.source !== null) {
        if (!record(rule.source) || !record(rule.source.confirmedBy) || !Number.isFinite(Date.parse(String(rule.source.confirmedAt)))) corrupt();
        keys(rule.source, ['type', 'reference', 'note', 'confirmedAt', 'confirmedBy']); validateStoredActor(rule.source.confirmedBy);
        sourceInput({ type: rule.source.type, reference: rule.source.reference, note: rule.source.note });
      }
      if (rule.exchangeRate !== null) {
        if (!record(rule.exchangeRate) || !record(rule.exchangeRate.confirmedBy) || typeof rule.exchangeRate.revision !== 'string') corrupt();
        keys(rule.exchangeRate, ['sourceCurrency', 'targetCurrency', 'direction', 'rate', 'effectiveFrom', 'source', 'revision', 'confirmedAt', 'confirmedBy']);
        validateStoredActor(rule.exchangeRate.confirmedBy);
        if (!Number.isFinite(Date.parse(String(rule.exchangeRate.confirmedAt)))) corrupt();
        const { sourceCurrency, targetCurrency, direction, rate: amount, effectiveFrom, source } = rule.exchangeRate;
        exchangeInput({ sourceCurrency, targetCurrency, direction, rate: amount, effectiveFrom, source });
      }
      if (rule.mode === 'custom' && rule.customPointsPerCny === null) corrupt();
      if (rule.mode === 'legacy_fixed') {
        normalizeDecimal(rule.legacyUnitCredits, { maxScale: 8, max: PRICING_ADMIN_LIMITS.maxTaskCredits, allowZero: true });
        if (rule.identity.billingMode !== 'fixed' || !['ceil_task', 'fixed_unit'].includes(String(rule.legacyRounding))) corrupt();
      }
      if (rule.mode === 'legacy_actual' && (rule.identity.billingMode !== 'actual' || rule.legacyPointsPerUsd !== '35' || rule.legacyRounding !== 'half_up_cent')) corrupt();
      if (rule.mode === 'follow' && value.standards[rule.basisKind as PricingAdminBasis] === null) corrupt();
      if (['follow', 'custom'].includes(String(rule.mode)) && (rule.identity.billingMode === 'actual' ? !rule.exchangeRate : !rule.source || !rule.baseCny)) corrupt();
    }
    const policy = value as unknown as Policy;
    if (new Set(policy.rules.map(rule => rule.id)).size !== policy.rules.length) corrupt();
    assertNoRuleAmbiguity(policy.rules);
    return policy;
  } catch { return corrupt(); }
}
function sameBinding(a: PricingCatalogBinding, b: PricingCatalogBinding) {
  // Transport revisions may include a display-only rename. Price evidence follows the actual scope/configuration.
  return a.billingPrincipalId === b.billingPrincipalId && a.credentialVersion === b.credentialVersion
    && a.configFingerprint === b.configFingerprint;
}
function effectiveRow(original: PricingAdminRow, policy: Policy, binding: PricingCatalogBinding): PricingAdminRow {
  const rule = selectPricingRule(policy.rules, original.identity);
  const result = { ...original };
  if (rule) {
    Object.assign(result, { mode: rule.mode, basisKind: rule.basisKind, baseCny: rule.baseCny, source: rule.source,
      exchangeRate: rule.exchangeRate, updatedAt: rule.updatedAt });
    if (!sameBinding(rule.binding, binding)) return { ...result, availability: 'needs_review', confirmation: 'needs_review',
      currentPointsPerCny: null, currentUnitCredits: null, canAdopt: false,
      adoptionReason: '供应商主体、凭据或适用配置已变，请重新确认依据', unavailableReason: '原价格依据与当前配置失配，新请求不能退回旧价' };
    if (rule.mode === 'legacy_fixed' || rule.mode === 'legacy_actual') {
      Object.assign(result, { currentUnitCredits: rule.legacyUnitCredits, legacyRounding: rule.legacyRounding,
        legacyPointsPerUsd: rule.legacyPointsPerUsd, currentPointsPerCny: null });
    } else if (rule.mode === 'free') {
      Object.assign(result, { currentUnitCredits: '0.0', currentPointsPerCny: null, confirmation: 'not_applicable' });
    } else {
      result.currentPointsPerCny = rule.mode === 'follow' ? policy.standards[rule.basisKind] : rule.customPointsPerCny;
      const sourceReady = original.identity.billingMode === 'actual'
        ? !!rule.exchangeRate && Date.parse(rule.exchangeRate.effectiveFrom) <= Date.now()
        : !!rule.baseCny && !!rule.source;
      result.confirmation = sourceReady ? 'confirmed' : 'unconfirmed';
      result.currentUnitCredits = sourceReady && result.currentPointsPerCny && rule.baseCny && original.identity.billingMode === 'fixed'
        ? roundDecimal(multiplyDecimal([rule.baseCny, result.currentPointsPerCny]), 1, 'half_up') : null;
    }
  }
  if (result.mode !== 'free' && result.currentPointsPerCny && policy.standards[result.basisKind]) {
    result.relativeMultiplier = divideDecimal(result.currentPointsPerCny, policy.standards[result.basisKind]!, 8);
    const comparison = compareDecimal(result.currentPointsPerCny, policy.standards[result.basisKind]!);
    result.hasDifference = comparison !== 0;
    const percent = divideDecimal(multiplyDecimal([result.currentPointsPerCny, '100']), policy.standards[result.basisKind]!, 8);
    result.differencePercent = signedDifferenceFromHundred(percent);
  }
  const actual = original.identity.billingMode === 'actual';
  result.canAdopt = result.availability === 'ready' && (actual
    ? !!result.exchangeRate && Date.parse(result.exchangeRate.effectiveFrom) <= Date.now()
    : !!result.baseCny && !!result.source);
  result.adoptionReason = result.canAdopt ? null : result.unavailableReason || (actual ? '请确认当前实际费用范围和已生效汇率' : '请补充独立人民币基价');
  return result;
}
function signedDifferenceFromHundred(value: string): string {
  return compareDecimal(value, '100') < 0 ? `-${subtractDecimal('100', value)}` : subtractDecimal(value, '100');
}
async function readState(client: PricingClient): Promise<State> {
  const stored = await client.platformSetting.findUnique({ where: { key: PRICING_POLICY_KEY } });
  const policy = stored ? parsePolicy(stored.value_json) : emptyPolicy();
  let revisionAuthoring: PricingAuthoring | undefined;
  if (stored) {
    const revision = await client.platformSetting.findUnique({ where: { key: `${PRICING_REVISION_PREFIX}${policy.revision}` } });
    if (!revision) corrupt();
    try { const value = JSON.parse(revision.value_json); if (pricingCanonical(value.policy) !== pricingCanonical(policy)) corrupt();
      revisionAuthoring = value.authoring;
      if (value.authoring && pricingCanonical(value.history?.authoringAfter) !== pricingCanonical(value.authoring)) corrupt();
    } catch { corrupt(); }
  }
  const catalog = await getPricingCatalog(client);
  await appendPricingCatalogScopes(catalog, policy.rules.map(rule => rule.identity), client, false);
  const authoringStored = await client.platformSetting.findUnique({ where: { key: PRICING_AUTHORING_KEY } });
  let authoring = emptyPricingAuthoring(policy.revision);
  try {
    if (authoringStored) {
      authoring = parsePricingAuthoring(authoringStored.value_json, policy.revision);
      if (!revisionAuthoring || pricingCanonical(revisionAuthoring) !== pricingCanonical(authoring)) throw new Error('编排历史与当前值不一致');
    } else if (revisionAuthoring) throw new Error('编排记录缺失');
  }
  catch { throw new PricingAdminServiceError('设置关系与实际费率不一致，未覆盖配置；请保留草稿', 409, 'pricing_authoring_conflict'); }
  for (const id of authoring.members) {
    const rule = policy.rules.find(item => item.id === id);
    if (!rule || rule.mode !== 'custom' || rule.customPointsPerCny !== authoring.globalPointsPerCny) throw new PricingAdminServiceError('统一成员与实际收费不一致，未重建默认值', 409, 'pricing_authoring_conflict');
  }
  for (const [id, entry] of Object.entries(authoring.entries)) {
    if (!entry.baseRelation) continue;
    const child = policy.rules.find(rule => rule.id === id), parent = policy.rules.find(rule => rule.id === entry.baseRelation!.parentId);
    if (!parent?.baseCny || !child?.baseCny) throw new PricingAdminServiceError('基价关系缺少实际收费行', 409, 'pricing_authoring_conflict');
    assertPricingBaseRelation(parent.identity, child.identity);
    if (derivedPricingBase(parent.baseCny, entry.baseRelation.factor).adopted !== child.baseCny
      || authoring.entries[parent.id]?.adoptedRevision && entry.baseRelation.parentRevision !== authoring.entries[parent.id].adoptedRevision) {
      throw new PricingAdminServiceError('父子基价与实际收费不一致', 409, 'pricing_authoring_conflict');
    }
  }
  return { policy, raw: stored?.value_json || null, catalog, authoring, authoringRaw: authoringStored?.value_json || null,
    rows: catalog.rows.map(value => projectPricingAuthoring(effectiveRow(value, policy, catalog.bindings[value.id]), authoring)) };
}
async function snapshot(actor: PricingAdminActor, state: State, client: PricingClient): Promise<PricingAdminSnapshot> {
  const runtime = await pricingImageConsumerState(client);
  return { schemaVersion: PRICING_ADMIN_SCHEMA, actor, revision: state.policy.revision, authoring: state.authoring,
    catalogFingerprint: state.catalog.fingerprint, standards: state.policy.standards, rows: state.rows,
    limits: PRICING_ADMIN_LIMITS, runtime: { imageReady: runtime.ready, reason: 'reason' in runtime ? runtime.reason || null : null },
    updatedAt: state.policy.updatedAt, updatedBy: state.policy.updatedBy };
}
export async function getAdminPricingSnapshot(actor: Actor, client: PricingClient = prisma): Promise<PricingAdminSnapshot> {
  if (client === prisma) return prisma.$transaction(tx => getAdminPricingSnapshot(actor, tx), { maxWait: 10000, timeout: 30000 });
  const admin = await freshActor(actor, client); return snapshot(admin, await readState(client), client);
}
function view(value: PricingAdminRow): PricingAdminPriceView {
  const { mode, baseCny, basisKind, currentPointsPerCny, currentUnitCredits, relativeMultiplier, differencePercent,
    confirmation, hasDifference, exchangeRate, authoringRateMode, authoringEntry } = value;
  return { mode, baseCny, basisKind, currentPointsPerCny, currentUnitCredits, relativeMultiplier,
    differencePercent, confirmation, hasDifference, exchangeRate, authoringRateMode, authoringEntry };
}
function toRule(row: PricingAdminRow, binding: PricingCatalogBinding, now: string): StoredRule {
  return { id: row.id, identity: row.identity, mode: row.mode, basisKind: row.basisKind, baseCny: row.baseCny,
    source: row.source, exchangeRate: row.exchangeRate, customPointsPerCny: row.mode === 'custom' ? row.currentPointsPerCny : null,
    binding, legacyUnitCredits: row.currentUnitCredits, legacyRounding: row.legacyRounding,
    legacyPointsPerUsd: row.legacyPointsPerUsd, updatedAt: now };
}
function confirmSource(input: PricingAdminSourceInput, actor: PricingAdminActor, now: string): PricingAdminSource {
  return { ...input, confirmedBy: actor, confirmedAt: now };
}
async function readRevision(id: string, client: PricingClient): Promise<Revision> {
  const row = await client.platformSetting.findUnique({ where: { key: `${PRICING_REVISION_PREFIX}${id}` } });
  if (!row) throw new PricingAdminServiceError('历史修订不存在', 404, 'pricing_revision_not_found');
  try {
    const value = JSON.parse(row.value_json) as Revision;
    parsePolicy(JSON.stringify(value.policy));
    if (value.authoring) parsePricingAuthoring(JSON.stringify(value.authoring), value.policy.revision);
    if (value.schemaVersion !== 1 || value.policy.revision !== id || value.history.revisionId !== id
      || !Array.isArray(value.rows) || !record(value.bindings)) corrupt();
    return value;
  } catch { return corrupt(); }
}
function simulationPrice(row: PricingAdminRow, quantity: string, example?: string) {
  if (row.mode === 'free') return { exact: '0', credits: '0.0' };
  if (row.availability !== 'ready') return null;
  if (row.identity.billingMode === 'actual') {
    if (example === undefined) return null;
    const exact = row.mode === 'legacy_actual' ? multiplyDecimal([example, row.legacyPointsPerUsd || '35'])
      : row.exchangeRate && row.currentPointsPerCny ? multiplyDecimal([example, row.exchangeRate.rate, row.currentPointsPerCny]) : null;
    if (exact === null) return null;
    const perTask = roundDecimal(exact, row.mode === 'legacy_actual' ? 2 : 1, 'half_up');
    if (compareDecimal(perTask, PRICING_ADMIN_LIMITS.maxImageCredits) > 0) fail('单个账单示例超过图片原授权边界');
    return { exact: multiplyDecimal([exact, quantity]), credits: multiplyDecimal([perTask, quantity]) };
  }
  const measured = row.identity.kind === 'enhance' || row.identity.kind === 'h3' ? roundDecimal(quantity, 0, 'ceil') : quantity;
  const exact = row.mode === 'legacy_fixed' && row.currentUnitCredits !== null ? multiplyDecimal([row.currentUnitCredits, measured])
    : row.baseCny && row.currentPointsPerCny ? multiplyDecimal([row.baseCny, row.currentPointsPerCny, measured]) : null;
  if (exact === null) return null;
  const credits = row.identity.kind === 'image'
    ? multiplyDecimal([row.mode === 'legacy_fixed' ? row.currentUnitCredits! : roundDecimal(multiplyDecimal([row.baseCny!, row.currentPointsPerCny!]), 1, 'half_up'), measured])
    : roundDecimal(exact, row.mode === 'legacy_fixed' && row.legacyRounding === 'ceil_task' ? 0 : 1,
      row.mode === 'legacy_fixed' && row.legacyRounding === 'ceil_task' ? 'ceil' : 'half_up');
  if (compareDecimal(credits, row.identity.kind === 'image' ? PRICING_ADMIN_LIMITS.maxImageCredits : PRICING_ADMIN_LIMITS.maxTaskCredits) > 0) fail('试算超过原业务金额上限');
  return { exact, credits };
}
function simulate(input: PricingAdminPreviewInput['simulation'], before: PricingAdminRow[], after: PricingAdminRow[], scopeIds = new Map<string, string>()): PricingAdminSimulation | null {
  if (!input) return null;
  const rowId = scopeIds.get(input.rowId) || input.rowId;
  const a = before.find(row => row.id === rowId), b = after.find(row => row.id === rowId);
  if (!a || !b) fail('试算项不在当前合法目录');
  if (a.identity.kind === 'video' && !isSeedanceVideoDuration(Number(input.quantity), a.identity.modelId)) fail('视频试算时长须符合当前型号原有的整数时长范围');
  if (a.identity.kind === 'image' && (input.quantity.includes('.') && compareDecimal(input.quantity, roundDecimal(input.quantity, 0, 'ceil')) !== 0
    || compareDecimal(input.quantity, '100') > 0)) fail('图片试算数量须为 1 至 100 整数，不扩大实际单次生成上限');
  const old = simulationPrice(a, input.quantity, input.exampleAmount), next = simulationPrice(b, input.quantity, input.exampleAmount);
  const delta = old && next ? compareDecimal(next.credits, old.credits) < 0
    ? `-${subtractDecimal(old.credits, next.credits)}` : subtractDecimal(next.credits, old.credits) : null;
  const percent = old && next && compareDecimal(old.credits, '0') > 0
    ? signedDifferenceFromHundred(divideDecimal(multiplyDecimal([next.credits, '100']), old.credits, 8)) : null;
  return { rowId: a.id, sourceRowId: input.rowId, specifications: { ...b.identity.specifications }, quantity: input.quantity, unit: a.identity.unit, currentCredits: old?.credits || null,
    deltaCredits: delta, differencePercent: percent, rounding: b.mode === 'legacy_fixed' || b.mode === 'legacy_actual' ? b.legacyRounding || 'legacy' : 'half_up_tenth',
    adjustedCredits: next?.credits || null, authorizedMaximumCredits: null, isExample: a.identity.billingMode === 'actual',
    roundedToZero: !!next && compareDecimal(next.exact, '0') > 0 && compareDecimal(next.credits, '0') === 0,
    exactCredits: next?.exact || null, reason: next ? a.identity.billingMode === 'actual' ? '仅为示例，实际费用须匹配真实账单；本试算不建立授权上限' : null : '依据、价格或实际示例金额尚未就绪' };
}
async function prepare(actor: PricingAdminActor, input: PricingAdminPreviewInput, state: State, client: PricingClient,
  confirmedAt = new Date().toISOString()): Promise<Prepared> {
  if (input.expectedRevision !== state.policy.revision || input.catalogFingerprint !== state.catalog.fingerprint) conflict(state.policy.revision);
  if (state.authoringRaw && input.expectedAuthoringRevision === undefined) throw new PricingAdminServiceError('请更新费率设置页后再保存，旧写入不能覆盖统一关系', 409, 'pricing_authoring_client_required');
  if (input.expectedAuthoringRevision !== undefined && input.expectedAuthoringRevision !== state.authoring.revision) conflict(state.policy.revision);
  const now = confirmedAt, next: Policy = structuredClone(state.policy), skipped: PricingAdminPreview['skipped'] = [];
  const authoring = structuredClone(state.authoring), authoringEnabled = input.expectedAuthoringRevision !== undefined;
  const scopeIds = new Map<string, string>();
  if (input.action.kind === 'save') for (const change of input.action.changes.rows) {
    if (!change.specifications) continue;
    if (!authoringEnabled) fail('精确规格需要新版设置合同');
    const original = state.catalog.rows.find(row => row.id === change.id);
    if (!original) fail('精确规格的原收费项不存在');
    const identity = { ...original.identity, specifications: { ...original.identity.specifications, ...change.specifications } };
    if (identity.kind === 'video' && (identity.specifications.referenceVideo === 'unknown' || identity.specifications.pricingPurpose === 'unknown')) fail('未知视频输入或用途不能建立确定新收费范围');
    await appendPricingCatalogScopes(state.catalog, [identity], client);
    const id = pricingCatalogRowId(identity); scopeIds.set(change.id, id);
    if (!state.rows.some(row => row.id === id)) state.rows.push(projectPricingAuthoring(effectiveRow(state.catalog.rows.find(row => row.id === id)!, state.policy, state.catalog.bindings[id]), state.authoring));
    // Preserve the original fallback contract for every other, unselected specification.
    if (!next.rules.some(rule => rule.id === original.id) && original.mode !== 'unset') next.rules.push(toRule(state.rows.find(row => row.id === original.id)!, state.catalog.bindings[original.id], now));
  }
  const requested = new Set<string>();
  const metadataOnly = new Set<string>();
  const find = (id: string) => { const value = state.rows.find(row => row.id === id); if (!value) fail('所选收费项已删除或不属于当前目录'); return value; };
  const put = (rule: StoredRule) => { const index = next.rules.findIndex(item => item.id === rule.id);
    if (index < 0) next.rules.push(rule); else next.rules[index] = rule; requested.add(rule.id); };
  if (input.action.kind === 'save') {
    Object.assign(next.standards, input.action.changes.standards || {});
    if (input.action.changes.authoring) {
      if (!authoringEnabled) fail('统一设置需要同时核对编排修订');
      if (input.action.changes.authoring.globalPointsPerCny !== undefined) authoring.globalPointsPerCny = input.action.changes.authoring.globalPointsPerCny;
    }
    for (const originalChange of input.action.changes.rows) {
      const change = { ...originalChange, id: scopeIds.get(originalChange.id) || originalChange.id };
      const current = find(change.id), original = state.catalog.rows.find(row => row.id === change.id)!;
      const removeMemberOnly = authoringEnabled && authoring.members.includes(change.id)
        && change.authoringRateMode === 'custom' && Object.keys(change).every(key => ['id', 'authoringRateMode'].includes(key));
      if (removeMemberOnly) {
        authoring.members = authoring.members.filter(id => id !== change.id);
        requested.add(change.id); metadataOnly.add(change.id); continue;
      }
      if (Object.keys(current.identity.specifications).length && !next.rules.some(rule => rule.id === current.id)) {
        const fallback = state.rows.find(row => row.identity.kind === current.identity.kind && row.identity.channelId === current.identity.channelId
          && row.identity.modelId === current.identity.modelId && row.identity.billingMode === current.identity.billingMode && !Object.keys(row.identity.specifications).length);
        if (fallback && fallback.mode !== 'unset' && !next.rules.some(rule => rule.id === fallback.id)) next.rules.push(toRule(fallback, state.catalog.bindings[fallback.id], now));
      }
      if (!current.enabled || original.availability !== 'ready') fail(`${current.label}：当前通道不可用，不能修改收费依据`);
      if (change.mode === 'legacy_fixed') fail('旧固定价只能从所选历史修订恢复，不能伪造旧价');
      const rule = next.rules.find(item => item.id === current.id) || toRule(current, state.catalog.bindings[current.id], now);
      const candidate = structuredClone(rule);
      const rebind = current.availability === 'needs_review';
      if (rebind && !(current.identity.billingMode === 'actual' ? change.exchangeRate : change.base)) fail(`${current.label}：来源已变化，请明确重新确认依据`);
      candidate.binding = state.catalog.bindings[current.id]; candidate.updatedAt = now;
      if (change.basisKind) candidate.basisKind = change.basisKind;
      if (candidate.basisKind !== (current.identity.billingMode === 'actual' ? 'supplier_cost_cny' : 'site_base_cny')) fail('固定站内基价与实际供应商费用依据不能混用');
      if (change.base) {
        if (current.identity.billingMode === 'actual' || change.base.unit !== current.identity.unit) fail('基价单位与收费项不一致，实际费用项不使用假固定单价');
        candidate.baseCny = change.base.amount; candidate.source = confirmSource(change.base.source, actor, now);
      }
      if (change.exchangeRate) {
        if (current.identity.billingMode !== 'actual') fail('固定站内基价不需要供应商汇率');
        if (change.exchangeRate.sourceCurrency !== 'USD') fail('当前实际费用协议只支持 USD 原币账单，不能自行扩大币种');
        candidate.exchangeRate = { ...change.exchangeRate, revision: pricingFingerprint({ change: change.exchangeRate, now, actor: actor.id }),
          confirmedAt: now, confirmedBy: actor };
      }
      if (change.mode) candidate.mode = change.mode;
      if (change.customPointsPerCny !== undefined) {
        if (change.mode && change.mode !== 'custom') fail('手填费率须为单独设置');
        candidate.mode = 'custom'; candidate.customPointsPerCny = change.customPointsPerCny;
      }
      if (candidate.mode === 'custom' && !candidate.customPointsPerCny) fail('请填写当前点/元');
      if (authoringEnabled) {
        const entry = structuredClone(authoring.entries[change.id] || newPricingAuthoringEntry());
        if (change.evidence) entry.evidence = change.evidence;
        if (change.base || change.specifications || change.evidence) {
          const evidenceMatches = entry.evidence?.currency === 'CNY' && entry.evidence.unit === current.identity.unit
            && candidate.baseCny !== null && compareDecimal(entry.evidence.amount, candidate.baseCny) === 0 && pricingCanonical(entry.evidence.specifications) === pricingCanonical(current.identity.specifications);
          entry.sourceKind = evidenceMatches ? entry.evidence!.kind : 'admin_defined';
          if (entry.sourceKind === 'admin_defined' && change.base) candidate.source = confirmSource({ type: 'admin_defined', reference: change.base.source.reference, note: change.base.source.note }, actor, now);
          entry.baseRelation = null;
          entry.adoptedRevision = pricingFingerprint({ base: candidate.baseCny, scope: current.identity, source: entry.sourceKind, evidence: entry.evidence });
        }
        if (change.baseRelation !== undefined) entry.baseRelation = change.baseRelation === null ? null : { ...change.baseRelation, parentRevision: '', exactProduct: '' };
        if (!entry.adoptedRevision || entry.adoptedRevision === 'pending') entry.adoptedRevision = pricingFingerprint({ base: candidate.baseCny, exchange: candidate.exchangeRate, identity: current.identity, source: candidate.source });
        authoring.entries[change.id] = entry;
        if (change.authoringRateMode === 'follow_global') {
          if (change.customPointsPerCny !== undefined || change.mode && change.mode !== 'custom') fail('统一跟随与单独费率不能同时指定');
          if (!authoring.members.includes(change.id)) authoring.members.push(change.id);
        } else if (change.authoringRateMode === 'custom' || change.customPointsPerCny !== undefined || change.mode !== undefined) {
          authoring.members = authoring.members.filter(id => id !== change.id);
        }
      } else if (change.authoringRateMode || change.baseRelation !== undefined || change.evidence) fail('来源与关系需要新版设置合同');
      put(candidate);
    }
  } else if (input.action.kind === 'unify') {
    if (authoringEnabled) fail('请选择统一所选加入草稿，再一次保存全部修改');
    const standard = next.standards[input.action.basisKind];
    if (!standard) fail('请先设置当前依据的统一标准');
    for (const id of input.action.ruleIds) {
      const current = find(id);
      if (current.basisKind !== input.action.basisKind || !current.canAdopt || current.mode === 'free') {
        skipped.push({ id, reason: current.mode === 'free' ? '明确免费不混入统一' : current.basisKind !== input.action.basisKind ? '计价依据不同' : current.adoptionReason || '当前不可采用' }); continue;
      }
      put({ ...(next.rules.find(item => item.id === id) || toRule(current, state.catalog.bindings[id], now)), mode: 'follow', updatedAt: now });
    }
  } else {
    const historic = await readRevision(input.action.revisionId, client);
    for (const name of input.action.standards || []) next.standards[name] = historic.policy.standards[name];
    for (const id of input.action.ruleIds) {
      const current = state.rows.find(row => row.id === id), previous = historic.rows.find(row => row.id === id);
      if (!current || !previous || !historic.bindings[id] || !sameBinding(historic.bindings[id], state.catalog.bindings[id]) || !current.enabled) {
        skipped.push({ id, reason: '原作用域已删除、停用或配置失配，未恢复或复活通道' }); continue;
      }
      const oldRule = historic.policy.rules.find(rule => rule.id === id);
      const restored = oldRule ? structuredClone(oldRule) : toRule(previous, historic.bindings[id], now);
      if (restored.mode === 'follow' && restored.customPointsPerCny === null) {
        const historicalRate = previous.currentPointsPerCny;
        if (!historicalRate) { skipped.push({ id, reason: '历史有效费率无法核实，未恢复' }); continue; }
        if (next.standards[restored.basisKind] !== historicalRate) { restored.mode = 'custom'; restored.customPointsPerCny = historicalRate; }
      }
      if (authoringEnabled) {
        authoring.members = authoring.members.filter(member => member !== id);
        const entry = structuredClone(historic.authoring?.entries[id] || newPricingAuthoringEntry());
        const relation = entry.baseRelation;
        if (relation && (!input.action.ruleIds.includes(relation.parentId)
          || !historic.rows.some(row => row.id === relation.parentId && row.baseCny
            && derivedPricingBase(row.baseCny, relation.factor).adopted === restored.baseCny))) {
          entry.baseRelation = null; entry.sourceKind = 'admin_defined';
          skipped.push({ id, reason: '恢复历史价，改为单独设置；未选择的父价保持不变' });
        }
        if (!entry.adoptedRevision || entry.adoptedRevision === 'pending') entry.adoptedRevision = pricingFingerprint({
          base: restored.baseCny, exchange: restored.exchangeRate, identity: current.identity, source: restored.source,
        });
        authoring.entries[id] = entry;
        if (historic.authoring?.members.includes(id) && previous.currentPointsPerCny === authoring.globalPointsPerCny) authoring.members.push(id);
      }
      restored.updatedAt = now; put(restored);
    }
    if (authoringEnabled) for (const [id, entry] of Object.entries(authoring.entries)) {
      if (entry.baseRelation && input.action.ruleIds.includes(entry.baseRelation.parentId) && !input.action.ruleIds.includes(id)) {
        entry.baseRelation = null; entry.sourceKind = 'admin_defined';
        skipped.push({ id, reason: '未选子项保持现价，已解除与本次历史父价的联动' });
      }
    }
  }
  if (authoringEnabled) {
    const changedParents = new Set(Array.from(requested).filter(id => !metadataOnly.has(id)
      && ((next.rules.find(rule => rule.id === id)?.baseCny ?? null) !== find(id).baseCny
        || authoring.entries[id]?.adoptedRevision !== state.authoring.entries[id]?.adoptedRevision)));
    for (const [id, entry] of Object.entries(authoring.entries)) {
      if (!entry.baseRelation || !changedParents.has(entry.baseRelation.parentId)
        && pricingCanonical(entry.baseRelation) === pricingCanonical(state.authoring.entries[id]?.baseRelation || null)) continue;
      const child = find(id), parent = find(entry.baseRelation.parentId);
      try { assertPricingBaseRelation(parent.identity, child.identity); }
      catch (error) { fail(error instanceof Error ? error.message : '基价跟随关系不合法'); }
      if (!sameBinding(state.catalog.bindings[id], state.catalog.bindings[parent.id])) fail('父子价格来源主体不相容');
      const parentRule = next.rules.find(rule => rule.id === parent.id), parentBase = parentRule?.baseCny || parent.baseCny;
      if (!parentBase) fail('父项没有独立人民币基价');
      let derived: ReturnType<typeof derivedPricingBase>;
      try { derived = derivedPricingBase(parentBase, entry.baseRelation.factor); }
      catch (error) { fail(error instanceof Error ? error.message : '派生基价无法安全保存'); }
      const candidate = structuredClone(next.rules.find(rule => rule.id === id) || toRule(child, state.catalog.bindings[id], now));
      candidate.baseCny = derived.adopted;
      candidate.updatedAt = now;
      candidate.source = confirmSource({ type: 'admin_defined', reference: '同范围2.0基价×1.5', note: `精确乘积${derived.exact}，采用8位基价${derived.adopted}` }, actor, now);
      entry.baseRelation = { ...entry.baseRelation, parentRevision: authoring.entries[parent.id]?.adoptedRevision || pricingFingerprint({ base: parentBase, revision: state.policy.revision }), exactProduct: derived.exact };
      entry.sourceKind = 'derived'; entry.adoptedRevision = pricingFingerprint({ parent: entry.baseRelation, base: derived.adopted });
      put(candidate);
    }
    for (const id of authoring.members) {
      const current = find(id), projected = effectiveRow(state.catalog.rows.find(row => row.id === id)!, next, state.catalog.bindings[id]);
      if (!authoring.globalPointsPerCny || !current.enabled || projected.availability !== 'ready' || !projected.canAdopt || projected.mode === 'free') fail(`${current.label}：统一成员不可用或依据待确认，请先明确移出该项，整组未保存`);
      const rule = structuredClone(next.rules.find(item => item.id === id) || toRule(current, state.catalog.bindings[id], now));
      if (rule.mode !== 'custom' || rule.customPointsPerCny !== authoring.globalPointsPerCny) rule.updatedAt = now;
      rule.mode = 'custom'; rule.customPointsPerCny = authoring.globalPointsPerCny; put(rule);
    }
    authoring.members.sort();
    const requestedGroup = input.action.kind === 'save' ? input.action.changes.authoring?.enhanceGroup : undefined;
    if (requestedGroup) {
      const groupRows = state.rows.filter(row => row.identity.kind === 'enhance');
      if (groupRows.length !== 20 || groupRows.some(row => row.mode !== 'legacy_fixed' || !row.enabled || row.availability !== 'ready')) fail('增强目录存在单独规则或不可用项，不能合并覆盖；请逐项编辑');
      const oldUnit = (resolution: string, toolVersion: string, fpsTier: string) => {
        const matches = groupRows.filter(row => row.identity.specifications.resolution === resolution && row.identity.specifications.toolVersion === toolVersion && row.identity.specifications.fpsTier === fpsTier);
        if (matches.length !== 1 || !matches[0].currentUnitCredits) fail('增强目录不是完整20种组合');
        return matches[0].currentUnitCredits!;
      };
      const professional = divideDecimal(oldUnit('480p', 'professional', 'lte30'), oldUnit('480p', 'standard', 'lte30'), 8);
      const highFps = divideDecimal(oldUnit('480p', 'standard', 'gt30'), oldUnit('480p', 'standard', 'lte30'), 8);
      for (const resolution of ['480p', '720p', '1080p', '2k', '4k']) for (const toolVersion of ['standard', 'professional']) for (const fpsTier of ['lte30', 'gt30']) {
        const expected = multiplyDecimal([oldUnit(resolution, 'standard', 'lte30'), toolVersion === 'professional' ? professional : '1', fpsTier === 'gt30' ? highFps : '1']);
        if (compareDecimal(expected, oldUnit(resolution, toolVersion, fpsTier)) !== 0) fail('现有增强价格含独立组合，不能用分组覆盖；请逐项编辑');
      }
      for (const current of groupRows) {
        const specs = current.identity.specifications;
        const base = requestedGroup.basePointsPerSecond[specs.resolution as keyof typeof requestedGroup.basePointsPerSecond];
        if (!base) fail('增强分组分辨率无效');
        const unit = multiplyDecimal([base, specs.toolVersion === 'professional' ? requestedGroup.professionalMultiplier : '1', specs.fpsTier === 'gt30' ? requestedGroup.highFpsMultiplier : '1']);
        const rule = toRule(current, state.catalog.bindings[current.id], now);
        rule.legacyUnitCredits = decimal(unit, { maxScale: 8, max: PRICING_ADMIN_LIMITS.maxTaskCredits, allowZero: false });
        put(rule);
      }
      authoring.enhanceGroup = structuredClone(requestedGroup);
    } else if (Array.from(requested).some(id => state.rows.find(row => row.id === id)?.identity.kind === 'enhance')) delete authoring.enhanceGroup;
  }
  assertNoRuleAmbiguity(next.rules);
  const rows = state.catalog.rows.map(row => projectPricingAuthoring(effectiveRow(row, next, state.catalog.bindings[row.id]), authoring));
  for (const id of Array.from(requested)) {
    if (metadataOnly.has(id)) continue;
    const value = rows.find(row => row.id === id)!;
    if (['follow', 'custom'].includes(value.mode) && (!value.canAdopt || !value.currentPointsPerCny)) fail(`${value.label}：${value.adoptionReason || '请设置有效费率或标准'}`);
    if (value.currentUnitCredits && compareDecimal(value.currentUnitCredits, value.identity.kind === 'image' ? PRICING_ADMIN_LIMITS.maxImageCredits : PRICING_ADMIN_LIMITS.maxTaskCredits) > 0) fail(`${value.label}：超过原业务金额上限`);
  }
  const changedStandards = (Object.keys(next.standards) as PricingAdminBasis[]).filter(name => next.standards[name] !== state.policy.standards[name]);
  // A standard change is atomic across its entire follow set, including off-screen rows.
  for (const row of rows.filter(value => value.mode === 'follow' && changedStandards.includes(value.basisKind))) {
    if (!row.canAdopt || !row.currentPointsPerCny) fail(`${row.label}：跟随项尚未就绪，不能只保存一部分统一标准`);
  }
  const affected = rows.filter((row, index) => pricingCanonical({ price: view(row), entry: row.authoringEntry, rateMode: row.authoringRateMode }) !== pricingCanonical({ price: view(state.rows[index]), entry: state.rows[index].authoringEntry, rateMode: state.rows[index].authoringRateMode })
    || requested.has(row.id) && pricingCanonical({ source: row.source, base: row.baseCny, mode: row.mode, exchange: row.exchangeRate })
      !== pricingCanonical({ source: state.rows[index].source, base: state.rows[index].baseCny, mode: state.rows[index].mode, exchange: state.rows[index].exchangeRate })).map(row => row.id);
  if (affected.length > PRICING_ADMIN_LIMITS.maxChanges) fail('完整影响范围超过 2000 项，未截断或部分保存');
  const chargeView = (row: PricingAdminRow) => {
    const { relativeMultiplier: _relative, differencePercent: _difference, hasDifference: _hasDifference, ...value } = view(row);
    return value;
  };
  const requiresImage = rows.some((row, index) => row.identity.kind === 'image' && affected.includes(row.id) && !metadataOnly.has(row.id)
    && pricingCanonical(chargeView(row)) !== pricingCanonical(chargeView(state.rows[index])));
  if (requiresImage) {
    try { await assertPricingImageConsumerReady(client); }
    catch (error) { throw new PricingAdminServiceError(error instanceof Error ? error.message : '图片收费服务尚未就绪', 503, 'pricing_consumer_unavailable'); }
  }
  const sourceRowId = (id: string) => Array.from(scopeIds).find(([, target]) => target === id)?.[0] || id;
  return { input, next, rows, affected, changes: affected.map(id => ({ id, sourceRowId: sourceRowId(id), specifications: { ...find(id).identity.specifications }, label: find(id).label,
    before: view(find(id)), after: view(rows.find(row => row.id === id)!) })), skipped,
    simulation: simulate(input.simulation, state.rows, rows, scopeIds), scenarios: (input.scenarios || []).map(item => simulate(item, state.rows, rows, scopeIds)!),
    authoring, authoringChanged: pricingAuthoringContent(authoring) !== pricingAuthoringContent(state.authoring), inputFingerprint: pricingFingerprint(input), confirmationTime: now };
}
function signingSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new PricingAdminServiceError('服务器未配置安全的预览签名密钥，费率未保存', 503, 'pricing_signing_unavailable');
  return secret;
}
function signature(body: string) { return createHmac('sha256', signingSecret()).update(`pricing-preview-v1\0${body}`).digest('base64url'); }
function signedPreview(actor: PricingAdminActor, prepared: Prepared, state: State) {
  const confirmedAt = prepared.confirmationTime;
  const expiresAt = new Date(Date.parse(confirmedAt) + PRICING_ADMIN_LIMITS.previewTtlMs).toISOString();
  const body = Buffer.from(JSON.stringify({ v: 1, actor: actor.id, input: prepared.inputFingerprint,
    revision: state.policy.revision, catalog: state.catalog.fingerprint, affected: prepared.affected,
    output: pricingFingerprint({ changes: prepared.changes, standards: prepared.next.standards, authoring: prepared.authoring, scenarios: prepared.scenarios }), confirmedAt, expiresAt })).toString('base64url');
  return { previewToken: `${body}.${signature(body)}`, expiresAt };
}
function previewPayload(token: string) {
  const parts = token.split('.');
  if (parts.length !== 2) conflict();
  const expected = Buffer.from(signature(parts[0])), provided = Buffer.from(parts[1]);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) conflict();
  try {
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (value.v !== 1 || !Number.isFinite(Date.parse(value.confirmedAt)) || Date.parse(value.confirmedAt) > Date.now()
      || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()
      || Date.parse(value.expiresAt) - Date.parse(value.confirmedAt) > PRICING_ADMIN_LIMITS.previewTtlMs + 1000) conflict();
    return value as { actor: string; input: string; revision: string; catalog: string; affected: string[];
      output: string; confirmedAt: string; expiresAt: string };
  } catch { return conflict(); }
}
function verifyPreview(token: string, actor: PricingAdminActor, prepared: Prepared, state: State) {
  try {
    const value = previewPayload(token);
    if (value.actor !== actor.id || value.input !== prepared.inputFingerprint || value.revision !== state.policy.revision
      || value.catalog !== state.catalog.fingerprint || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()
      || Date.parse(value.expiresAt) > Date.now() + PRICING_ADMIN_LIMITS.previewTtlMs
      || pricingCanonical(value.affected) !== pricingCanonical(prepared.affected)
      || value.output !== pricingFingerprint({ changes: prepared.changes, standards: prepared.next.standards, authoring: prepared.authoring, scenarios: prepared.scenarios })) conflict(state.policy.revision);
  } catch { conflict(state.policy.revision); }
}
export async function previewAdminPricing(actor: Actor, input: PricingAdminPreviewInput, client: PricingClient = prisma): Promise<PricingAdminPreview> {
  if (client === prisma) return prisma.$transaction(tx => previewAdminPricing(actor, input, tx), { maxWait: 10000, timeout: 30000 });
  const admin = await freshActor(actor, client), parsed = parsePreview(input), state = await readState(client);
  const prepared = await prepare(admin, parsed, state, client);
  return { ...signedPreview(admin, prepared, state), expectedRevision: state.policy.revision,
    catalogFingerprint: state.catalog.fingerprint, inputFingerprint: prepared.inputFingerprint,
    affectedRuleIds: prepared.affected, changes: prepared.changes, skipped: prepared.skipped, simulation: prepared.simulation,
    authoringRevision: state.authoring.revision, authoringChanged: prepared.authoringChanged, scenarios: prepared.scenarios };
}
function operationId(value: unknown) { const id = textValue(value, 128); if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(id)) fail('保存操作编号无效'); return id; }
function receiptKey(actor: Actor, id: string) { return `${PRICING_OPERATION_PREFIX}${actor.id}:${id}`; }
async function receipt(actor: Actor, id: string, client: PricingClient): Promise<Receipt | null> {
  const row = await client.platformSetting.findUnique({ where: { key: receiptKey(actor, id) } });
  if (!row) return null;
  try { const value = JSON.parse(row.value_json) as Receipt;
    if (value.schemaVersion !== 1 || value.actorId !== actor.id || value.result.operationId !== id
      || !['succeeded', 'rejected'].includes(value.result.state) || typeof value.requestFingerprint !== 'string') corrupt();
    return value;
  } catch { return corrupt(); }
}
export async function getAdminPricingOperation(actor: Actor, id: string, client: PricingClient = prisma): Promise<PricingAdminOperation> {
  if (client === prisma) return prisma.$transaction(tx => getAdminPricingOperation(actor, id, tx), { maxWait: 10000, timeout: 10000 });
  await freshActor(actor, client); const op = operationId(id), found = await receipt(actor, op, client);
  return found?.result || { operationId: op, state: 'unknown', inputFingerprint: null, revision: null,
    affectedRuleIds: [], error: null, snapshot: null };
}
export async function saveAdminPricing(actor: Actor, input: PricingAdminSaveInput, client?: PricingClient): Promise<PricingAdminOperation> {
  if (!record(input) || Buffer.byteLength(JSON.stringify(input), 'utf8') > PRICING_ADMIN_LIMITS.maxRequestBytes) fail('保存请求过大或无效');
  const id = operationId(input.operationId), requestFingerprint = pricingFingerprint(input);
  const save = async (tx: PricingClient): Promise<PricingAdminOperation> => {
    const admin = await freshActor(actor, tx), previous = await receipt(admin, id, tx);
    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint) throw new PricingAdminServiceError('同一保存编号对应了不同内容，请先查询原操作', 409, 'pricing_operation_mismatch');
      return previous.result;
    }
    let parsed: PricingAdminPreviewInput | null = null, state: State | null = null;
    let prepared: Prepared;
    try {
      parsed = parsePreview(input, true); state = await readState(tx);
      const token = textValue(input.previewToken, 32768), payload = previewPayload(token);
      prepared = await prepare(admin, parsed, state, tx, payload.confirmedAt);
      verifyPreview(token, admin, prepared, state);
    } catch (error) {
      const failure = error instanceof PricingAdminServiceError ? error
        : error instanceof PricingNumberError || error instanceof PricingRuleConflict ? new PricingAdminServiceError(error.message, error.status, error.code) : null;
      if (!failure) throw error;
      const result: PricingAdminOperation = { operationId: id, state: 'rejected', inputFingerprint: parsed ? pricingFingerprint(parsed) : null,
        revision: state?.policy.revision || null, affectedRuleIds: [],
        error: { code: failure.code, message: failure.message, ...(failure.fields ? { fields: failure.fields } : {}) }, snapshot: null };
      await tx.platformSetting.create({ data: { key: receiptKey(admin, id), value_json: JSON.stringify({ schemaVersion: 1, actorId: admin.id, requestFingerprint, result } satisfies Receipt), updated_by: admin.id } });
      return result;
    }
    const current = state!;
    const changedStandards = pricingCanonical(prepared.next.standards) !== pricingCanonical(current.policy.standards);
    if (!prepared.affected.length && !changedStandards && !prepared.authoringChanged) {
      const result: PricingAdminOperation = { operationId: id, state: 'succeeded', inputFingerprint: prepared.inputFingerprint,
        revision: current.policy.revision, affectedRuleIds: [], error: null, snapshot: await snapshot(admin, current, tx) };
      await tx.platformSetting.create({ data: { key: receiptKey(admin, id), value_json: JSON.stringify({ schemaVersion: 1, actorId: admin.id, requestFingerprint, result } satisfies Receipt), updated_by: admin.id } });
      return result;
    }
    const now = new Date().toISOString(), revisionId = randomUUID();
    prepared.next.revision = revisionId; prepared.next.updatedAt = now; prepared.next.updatedBy = admin;
    const persistAuthoring = current.authoringRaw !== null || prepared.authoringChanged;
    if (persistAuthoring) {
      prepared.authoring.revision = randomUUID(); prepared.authoring.policyRevision = revisionId;
      const authoringJson = JSON.stringify(prepared.authoring);
      if (current.authoringRaw !== null) {
        const swapped = await tx.platformSetting.updateMany({ where: { key: PRICING_AUTHORING_KEY, value_json: current.authoringRaw }, data: { value_json: authoringJson, updated_by: admin.id } });
        if (swapped.count !== 1) conflict(current.policy.revision);
      } else await tx.platformSetting.create({ data: { key: PRICING_AUTHORING_KEY, value_json: authoringJson, updated_by: admin.id } });
    }
    const valueJson = JSON.stringify(prepared.next);
    // Compare the entire previous JSON, not only a client-supplied revision number.
    if (current.raw !== null) {
      const swapped = await tx.platformSetting.updateMany({ where: { key: PRICING_POLICY_KEY, value_json: current.raw }, data: { value_json: valueJson, updated_by: admin.id } });
      if (swapped.count !== 1) conflict(current.policy.revision);
    } else await tx.platformSetting.create({ data: { key: PRICING_POLICY_KEY, value_json: valueJson, updated_by: admin.id } });
    const history: PricingAdminHistoryEntry = { revisionId, previousRevision: current.policy.revision, createdAt: now,
      actor: admin, action: prepared.input.action.kind, changes: prepared.changes,
      standardsBefore: current.policy.standards, standardsAfter: prepared.next.standards,
      ...(persistAuthoring ? { authoringBefore: current.authoring, authoringAfter: prepared.authoring } : {}) };
    const revision: Revision = { schemaVersion: 1, policy: prepared.next, ...(persistAuthoring ? { authoring: prepared.authoring } : {}), history, rows: prepared.rows, bindings: current.catalog.bindings };
    await tx.platformSetting.create({ data: { key: `${PRICING_REVISION_PREFIX}${revisionId}`, value_json: JSON.stringify(revision), updated_by: admin.id } });
    const result: PricingAdminOperation = { operationId: id, state: 'succeeded', inputFingerprint: prepared.inputFingerprint, revision: revisionId,
      affectedRuleIds: prepared.affected, error: null, ...(persistAuthoring ? { authoringRevision: prepared.authoring.revision } : {}), snapshot: await snapshot(admin, await readState(tx), tx) };
    await tx.platformSetting.create({ data: { key: receiptKey(admin, id), value_json: JSON.stringify({ schemaVersion: 1, actorId: admin.id, requestFingerprint, result } satisfies Receipt), updated_by: admin.id } });
    return result;
  };
  if (client && !('$transaction' in client)) return save(client);
  const root = client && '$transaction' in client ? client as typeof prisma : prisma;
  try { return await root.$transaction(tx => save(tx), { maxWait: 10000, timeout: 30000 }); }
  catch (error) {
    const code = record(error) ? error.code : null;
    if (!['P2002', 'P2034'].includes(String(code))) throw error;
    // These transaction failures are known rollbacks. Record a refusal under the same operation, never replay its mutation.
    return root.$transaction(async tx => {
      const admin = await freshActor(actor, tx), existing = await receipt(admin, id, tx);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) throw new PricingAdminServiceError('同一保存编号对应了不同内容，请先查询原操作', 409, 'pricing_operation_mismatch');
        return existing.result;
      }
      const pointer = await tx.platformSetting.findUnique({ where: { key: PRICING_POLICY_KEY } });
      const revision = pointer ? parsePolicy(pointer.value_json).revision : PRICING_UNCONFIGURED_REVISION;
      const result: PricingAdminOperation = { operationId: id, state: 'rejected', inputFingerprint: null, revision,
        affectedRuleIds: [], error: { code: 'pricing_conflict', message: '另一个保存已先完成，本次整批未生效，请重新预览' }, snapshot: null };
      await tx.platformSetting.create({ data: { key: receiptKey(admin, id), value_json: JSON.stringify({ schemaVersion: 1, actorId: admin.id, requestFingerprint, result } satisfies Receipt), updated_by: admin.id } });
      return result;
    }, { maxWait: 10000, timeout: 10000 });
  }
}
export async function getAdminPricingHistory(actor: Actor, input: { cursor?: string; limit?: number } = {}, client: PricingClient = prisma): Promise<PricingAdminHistory> {
  if (client === prisma) return prisma.$transaction(tx => getAdminPricingHistory(actor, input, tx), { maxWait: 10000, timeout: 30000 });
  await freshActor(actor, client); keys(input, ['cursor', 'limit']);
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('历史分页数量须为 1 至 100');
  const current = await readState(client);
  let id = input.cursor ? textValue(input.cursor, 160) : current.policy.revision;
  const entries: PricingAdminHistoryEntry[] = [], seen = new Set<string>();
  while (id !== PRICING_UNCONFIGURED_REVISION && entries.length < limit) {
    if (seen.has(id)) corrupt(); seen.add(id);
    const revision = await readRevision(id, client); entries.push(revision.history); id = revision.history.previousRevision;
  }
  return { entries, nextCursor: id === PRICING_UNCONFIGURED_REVISION ? null : id };
}
function parseFilter(value: PricingAdminFilter) {
  keys(value, ['kind', 'search', 'channelId', 'defaultsOnly', 'difference', 'basisKind']);
  if (value.kind !== undefined && !['all', 'video', 'image', 'enhance', 'h3'].includes(value.kind)) fail('业务筛选无效');
  if (value.difference !== undefined && !['all', 'different', 'unconfirmed', 'custom'].includes(value.difference)) fail('差异筛选无效');
  if (value.basisKind !== undefined) basis(value.basisKind);
  if (value.search !== undefined) textValue(value.search, 200, false);
  if (value.channelId !== undefined) textValue(value.channelId, 160);
  if (value.defaultsOnly !== undefined && typeof value.defaultsOnly !== 'boolean') fail('默认供应商筛选无效');
  return value;
}
function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s\uFEFF]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export async function exportAdminPricingCsv(actor: Actor, input: PricingAdminFilter = {}, client: PricingClient = prisma): Promise<string> {
  if (client === prisma) return prisma.$transaction(tx => exportAdminPricingCsv(actor, input, tx), { maxWait: 10000, timeout: 30000 });
  const filter = parseFilter(input), data = await getAdminPricingSnapshot(actor, client), exportedAt = new Date().toISOString();
  const rows = filterPricingAdminRows(data.rows, filter);
  const header = ['revision', 'exportedAt', 'timezone', 'ruleId', 'kind', 'channelId', 'modelId', 'specifications', 'label', 'provider',
    'unit', 'mode', 'basis', 'baseCny', 'pointsPerCny', 'unitCredits', 'confirmation', 'sourceType', 'sourceReference', 'confirmedAt', 'confirmedBy',
    'legacyRounding', 'legacyPointsPerUsd', 'exchangeSourceCurrency', 'exchangeDirection', 'exchangeRate', 'exchangeEffectiveFrom', 'exchangeRevision',
    'exchangeSourceType', 'exchangeSourceReference', 'exchangeConfirmedAt', 'exchangeConfirmedBy', 'authoringRevision', 'globalPointsPerCny', 'authoringRateMode', 'sourceKind', 'evidence', 'baseRelation'];
  return '\uFEFF' + [header, ...rows.map(row => [data.revision, exportedAt, 'UTC', row.id, row.identity.kind, row.identity.channelId,
    row.identity.modelId, pricingCanonical(row.identity.specifications), pricingDisplayName(row), row.providerLabel, row.identity.unit, row.mode,
    row.basisKind, row.baseCny, row.currentPointsPerCny, row.currentUnitCredits, row.confirmation, row.source?.type, row.source?.reference,
    row.source?.confirmedAt, row.source?.confirmedBy.id, row.legacyRounding, row.legacyPointsPerUsd,
    row.exchangeRate?.sourceCurrency, row.exchangeRate?.direction, row.exchangeRate?.rate,
    row.exchangeRate?.effectiveFrom, row.exchangeRate?.revision, row.exchangeRate?.source.type,
    row.exchangeRate?.source.reference, row.exchangeRate?.confirmedAt, row.exchangeRate?.confirmedBy.id,
    data.authoring?.revision, data.authoring?.globalPointsPerCny, row.authoringRateMode, row.authoringEntry?.sourceKind,
    row.authoringEntry?.evidence ? pricingCanonical(row.authoringEntry.evidence) : '', row.authoringEntry?.baseRelation ? pricingCanonical(row.authoringEntry.baseRelation) : ''])].map(values => values.map(csvCell).join(',')).join('\r\n');
}

export async function resolvePricingCharge(identity: PricingAdminIdentity, client: PricingClient = prisma): Promise<{
  revision: string; ruleId: string; row: PricingAdminRow; binding: PricingCatalogBinding;
} | null> {
  if (client === prisma) return prisma.$transaction(tx => resolvePricingCharge(identity, tx), { maxWait: 10000, timeout: 30000 });
  const stored = await client.platformSetting.findUnique({ where: { key: PRICING_POLICY_KEY } });
  const policy = stored ? parsePolicy(stored.value_json) : emptyPolicy();
  const adopted = selectPricingRule(policy.rules, identity);
  if (!adopted && policy.rules.some(rule => rule.identity.kind === identity.kind && rule.identity.channelId === identity.channelId
    && rule.identity.modelId === identity.modelId && rule.identity.unit === identity.unit)) {
    throw new PricingAdminServiceError('该收费作用域已采用新策略，但当前规格没有唯一规则，未回退旧价', 409, 'pricing_scope_unmatched');
  }
  await assertPricingCatalogIdentity(identity, client, Boolean(adopted && ['follow', 'custom'].includes(adopted.mode) && adopted.baseCny && adopted.source));
  if (!adopted) return null;
  const state = await readState(client);
  const catalogRow = selectPricingRule(state.catalog.rows, identity);
  if (!catalogRow) throw new PricingAdminServiceError('当前规格没有唯一且已确认的收费目录项，未回退旧价', 409, 'pricing_scope_unmatched');
  const row = state.rows.find(item => item.id === catalogRow.id)!;
  if (row.availability !== 'ready' || row.mode === 'unset' || row.confirmation === 'needs_review') {
    const message = row.unavailableReason || '收费依据未就绪，未回退旧价';
    if (identity.kind === 'image') throw new PricingItemUnavailableError(identity, row.mode === 'unset' ? 'price_unconfigured' : 'evidence_unconfirmed', message);
    throw new PricingAdminServiceError(message, 409, 'pricing_charge_unavailable');
  }
  if (['follow', 'custom'].includes(row.mode) && (!row.canAdopt || !row.currentPointsPerCny)) {
    if (identity.kind === 'image') throw new PricingItemUnavailableError(identity, 'evidence_unconfirmed', '已采用新策略的收费项缺少有效依据，不能使用旧价');
    throw new PricingAdminServiceError('已采用新策略的收费项缺少有效依据，不能使用旧价', 409, 'pricing_evidence_unavailable');
  }
  if (identity.kind === 'image') await assertPricingImageConsumerReady(client);
  return { revision: state.policy.revision, ruleId: adopted.id, row, binding: state.catalog.bindings[catalogRow.id] };
}
