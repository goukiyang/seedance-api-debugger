import { pricingCanonical } from './catalog';
import { compareDecimal, multiplyDecimal, normalizeDecimal, roundDecimal, divideDecimal, subtractDecimal } from './math';
import type { PricingAdminIdentity, PricingAdminRow } from './admin-contract';
import type { PricingAuthoring, PricingAuthoringEntry } from './pricing-authoring-contract';

export function emptyPricingAuthoring(policyRevision: string): PricingAuthoring {
  return { schemaVersion: 1, revision: 'unconfigured', policyRevision, globalPointsPerCny: null, members: [], entries: {} };
}
export function parsePricingAuthoring(raw: string, policyRevision: string): PricingAuthoring {
  const value = JSON.parse(raw) as PricingAuthoring;
  const object = (item: unknown) => !!item && typeof item === 'object' && !Array.isArray(item);
  if (!object(value) || value.schemaVersion !== 1 || typeof value.revision !== 'string'
    || value.policyRevision !== policyRevision || !Array.isArray(value.members) || value.members.length > 2000
    || value.members.some(id => typeof id !== 'string') || new Set(value.members).size !== value.members.length
    || !object(value.entries) || Object.keys(value.entries).length > 2000
    || Object.keys(value).some(key => !['schemaVersion', 'revision', 'policyRevision', 'globalPointsPerCny', 'members', 'entries', 'enhanceGroup'].includes(key))) throw new Error('计价编排与收费规则不相容');
  if (value.globalPointsPerCny !== null) normalizeDecimal(value.globalPointsPerCny, { maxScale: 1, min: '0.1', max: '10000', allowZero: false });
  if (value.members.length && value.globalPointsPerCny === null) throw new Error('统一成员缺少标准');
  if (value.enhanceGroup) {
    const group = value.enhanceGroup;
    if (!object(group) || Object.keys(group).sort().join(',') !== 'basePointsPerSecond,highFpsMultiplier,professionalMultiplier'
      || !object(group.basePointsPerSecond) || Object.keys(group.basePointsPerSecond).sort().join(',') !== '1080p,2k,480p,4k,720p') throw new Error('增强基础档不完整');
    for (const amount of Object.values(group.basePointsPerSecond)) normalizeDecimal(amount, { maxScale: 8, max: '1000000', allowZero: false });
    for (const factor of [group.professionalMultiplier, group.highFpsMultiplier]) normalizeDecimal(factor, { maxScale: 8, max: '100', allowZero: false });
  }
  for (const entry of Object.values(value.entries)) {
    if (!object(entry) || typeof entry.adoptedRevision !== 'string'
      || !['user_provided', 'historical_statement', 'derived', 'admin_defined', 'unconfirmed'].includes(entry.sourceKind)) throw new Error('计价来源损坏');
    if (entry.evidence) {
      const evidence = entry.evidence;
      normalizeDecimal(evidence.amount, { maxScale: 18, max: '1000000', allowZero: false });
      if (!['user_provided', 'historical_statement', 'derived', 'admin_defined', 'unconfirmed'].includes(evidence.kind)
        || !['CNY', 'USD'].includes(evidence.currency) || !['image', 'second'].includes(evidence.unit)
        || !object(evidence.specifications) || typeof evidence.reference !== 'string' || typeof evidence.version !== 'string'
        || evidence.reference.length > 2000 || evidence.version.length > 160
        || Object.keys(evidence.specifications).length > 5 || Object.values(evidence.specifications).some(item => typeof item !== 'string' || item.length > 64)
        || evidence.exchangeAssumption !== null && typeof evidence.exchangeAssumption !== 'string'
        || evidence.sampledAt !== null && !Number.isFinite(Date.parse(evidence.sampledAt))) throw new Error('原始价格证据损坏');
    }
    if (entry.baseRelation) {
      const relation = entry.baseRelation;
      if (typeof relation.parentId !== 'string' || relation.factor !== '1.5' || typeof relation.parentRevision !== 'string') throw new Error('基价跟随关系损坏');
      normalizeDecimal(relation.exactProduct, { maxScale: 18, max: '1000000', allowZero: false });
    }
  }
  return value;
}
export function pricingAuthoringContent(value: PricingAuthoring) {
  return pricingCanonical({ globalPointsPerCny: value.globalPointsPerCny, members: [...value.members].sort(), entries: value.entries, enhanceGroup: value.enhanceGroup || null });
}
export function derivedPricingBase(parent: string, factor: string) {
  const exact = multiplyDecimal([parent, factor]);
  const adopted = roundDecimal(exact, 8, 'half_up');
  if (compareDecimal(adopted, '0') <= 0 || compareDecimal(adopted, '1000000') > 0) throw new Error('派生基价超界或舍入为零，未保存');
  return { exact, adopted };
}
export function assertPricingBaseRelation(parent: PricingAdminIdentity, child: PricingAdminIdentity) {
  if (parent.kind !== 'video' || child.kind !== 'video' || parent.channelId !== 'seedance' || child.channelId !== parent.channelId
    || !/seedance.*2[.\-]0/i.test(parent.modelId) || !/seedance.*2[.\-]5/i.test(child.modelId)
    || parent.billingMode !== 'fixed' || child.billingMode !== 'fixed'
    || pricingCanonical(parent.specifications) !== pricingCanonical(child.specifications)
    || !parent.specifications.resolution || parent.specifications.referenceVideo !== 'none'
    || parent.specifications.pricingPurpose !== 'standard') throw new Error('仅同供应商、分辨率和普通无参考视频范围允许2.0到2.5跟随');
}
export function projectPricingAuthoring(row: PricingAdminRow, authoring: PricingAuthoring): PricingAdminRow {
  const member = authoring.members.includes(row.id), entry = authoring.entries[row.id];
  let relativeMultiplier: string | null = null, differencePercent: string | null = null;
  if (row.currentPointsPerCny && authoring.globalPointsPerCny) {
    // Reuse the same decimal projection as the saved materialized price.
    relativeMultiplier = divideDecimal(row.currentPointsPerCny, authoring.globalPointsPerCny, 8);
    const percent = divideDecimal(multiplyDecimal([row.currentPointsPerCny, '100']), authoring.globalPointsPerCny, 8);
    differencePercent = compareDecimal(percent, '100') < 0 ? `-${subtractDecimal('100', percent)}` : subtractDecimal(percent, '100');
  }
  return { ...row, authoringRateMode: member ? 'follow_global' : row.mode === 'follow' ? 'legacy_follow' : 'custom',
    authoringEntry: entry || null, ...(authoring.globalPointsPerCny ? { relativeMultiplier, differencePercent,
      hasDifference: row.currentPointsPerCny !== null && compareDecimal(row.currentPointsPerCny, authoring.globalPointsPerCny) !== 0 } : {}) };
}
export function newPricingAuthoringEntry(): PricingAuthoringEntry {
  return { adoptedRevision: 'pending', sourceKind: 'admin_defined', evidence: null, baseRelation: null };
}
