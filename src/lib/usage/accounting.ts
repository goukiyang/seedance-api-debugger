import { Prisma } from '@prisma/client';
import type { UsageFact } from '@/lib/admin/usage-types';
import { usageDecimalUnits, usageInteger } from '@/lib/admin/usage-money';
import type { PricingRule, PricingPolicy } from '@/lib/pricing/types';
import { multiplyDecimal, roundDecimal, sumDecimal, divideDecimal } from '@/lib/pricing/math';
import { PricingRuleConflict, selectPricingRule } from '@/lib/pricing/resolve';
import { getDefaultReferenceSettings, parseReferenceSettings, type ReferencePricingKind, type ReferencePricingSettings } from '@/lib/pricing/reference-contract';
import { usageDatabase, type UsageDb, type UsageDbSource } from './database';

export type AccountingCost = {
  amountCnyMicros: string;
  source: 'current_rate' | 'historical_reference' | 'type_default' | 'asset' | 'asset_rate' | 'frozen_rate' | 'recorded_rate' | 'provider_response';
  detail: string; revision: string | null;
  unitCny?: string; unit?: 'image' | 'second' | 'call'; quantity?: string;
  points?: string; pointsPerCny?: string; included?: boolean; estimated?: boolean;
  ruleId?: string | null; mappingRevision?: string;
};
export type AccountingRow = Record<string, string | number | bigint | Date | boolean | null>;
type Rule = PricingRule & { rounding?: string };
export type CurrentRateBasis = {
  revision: string | null; rules: Rule[]; qualityRoutes: Record<string, Record<string, string>>;
  settings: ReferencePricingSettings; pointsPerCny: string | null;
  standards?: PricingPolicy['standards'];
};
export type ReferenceFact = Pick<UsageFact, 'sourceKind' | 'model' | 'kind' | 'status' | 'outputCount'>;
const contexts = new WeakMap<UsageDb, Promise<CurrentRateBasis>>();
const positive = (value: unknown) => value !== null && value !== undefined && /^\d+(?:\.\d{1,8})?$/.test(String(value)) && Number(value) > 0;

/** One public-price context per read snapshot; never read provider credentials or old cash here. */
export async function readCurrentRateBasis(source: UsageDbSource): Promise<CurrentRateBasis> {
  const db = usageDatabase(source);
  let context = contexts.get(db);
  if (!context) {
    context = (async () => {
      const rows = await db.$queryRaw<Array<{ revision: string; standards: string; rule: string }>>(Prisma.sql`
        SELECT json_extract(p.value_json, '$.revision') AS revision, json_extract(p.value_json, '$.standards') AS standards,
          json_object('id', json_extract(r.value, '$.id'), 'identity', json_extract(r.value, '$.identity'),
            'mode', json_extract(r.value, '$.mode'), 'baseCny', json_extract(r.value, '$.baseCny'),
            'basisKind', json_extract(r.value, '$.basisKind'), 'customPointsPerCny', json_extract(r.value, '$.customPointsPerCny'),
            'source', json_extract(r.value, '$.source'), 'rounding', json_extract(r.value, '$.rounding')) AS rule
        FROM PlatformSetting p, json_each(CASE WHEN json_valid(p.value_json) THEN p.value_json ELSE '{}' END, '$.rules') r
        WHERE p.key = 'pricing_policy_v1' AND json_extract(p.value_json, '$.schemaVersion') = 1
          AND (json_extract(r.value, '$.source.confirmedAt') IS NOT NULL OR json_extract(r.value, '$.mode') = 'free')`);
      const settings = await db.$queryRaw<Array<{ key: string; value: string | null }>>(Prisma.sql`
        SELECT key, CASE WHEN key = 'image_generation_model_defaults_v1' THEN json_extract(value_json, '$.qualityRoutes')
          WHEN key = 'pricing_authoring_v1' THEN json_extract(value_json, '$.globalPointsPerCny') ELSE value_json END AS value
        FROM PlatformSetting WHERE key IN ('image_generation_model_defaults_v1', 'pricing_authoring_v1', 'usage_reference_pricing_v1')`);
      const rules = rows.map(row => ({ ...JSON.parse(row.rule), exchangeRate: null } as Rule));
      if (rules.some(rule => !rule.identity || !rule.identity.specifications || typeof rule.identity.modelId !== 'string'
        || rule.baseCny !== null && !/^\d+(?:\.\d{1,8})?$/.test(rule.baseCny))) throw new Error('usage_accounting_policy_invalid');
      const standards = rows[0]?.standards ? JSON.parse(rows[0].standards) : { site_base_cny: null, supplier_cost_cny: null };
      const policy: PricingPolicy = { schemaVersion: 1, revision: rows[0]?.revision || 'unconfigured', rules, standards };
      const raw = settings.find(row => row.key === 'usage_reference_pricing_v1')?.value;
      const quality = settings.find(row => row.key === 'image_generation_model_defaults_v1')?.value;
      return { revision: rows[0]?.revision || null, rules, standards, qualityRoutes: quality ? JSON.parse(quality) : {},
        settings: raw ? parseReferenceSettings(JSON.parse(raw)) : getDefaultReferenceSettings(policy),
        pointsPerCny: settings.find(row => row.key === 'pricing_authoring_v1')?.value || standards.site_base_cny };
    })();
    contexts.set(db, context);
  }
  return context;
}

function referenceKind(fact: ReferenceFact, row: AccountingRow): ReferencePricingKind {
  return fact.kind === 'image' ? 'image' : fact.kind === 'text' ? 'text' : fact.kind === 'cutout' ? 'cutout'
    : row.provider === 'h3' ? 'h3' : row.provider === 'volcengine_mediakit' ? 'enhance' : 'video';
}

/** Current valuation only. Generation/settlement continue to use their original frozen contracts. */
export function calculateRateCost(fact: ReferenceFact, row: AccountingRow, basis: CurrentRateBasis): AccountingCost | null {
  const kind = referenceKind(fact, row), model = fact.model || '';
  const fallback = basis.settings.defaults[kind];
  const eligible = basis.rules.filter(rule => rule.identity.kind === kind && rule.identity.billingMode === 'fixed'
    && (rule.mode === 'free' || ['follow', 'custom'].includes(rule.mode) && rule.baseCny !== null));
  const quality = String(row.quality || ''), channel = String(row.channel_id || row.provider || '');
  const specifications: Record<string, string> = kind === 'image' ? { quality, resolution: String(row.output_size || '') } : {
    resolution: String(row.resolution || ''), referenceVideo: row.reference_video_urls ? 'present' : 'none',
    pricingPurpose: row.is_upgrade ? 'draft_upgrade' : row.is_draft ? 'draft' : 'standard',
    toolVersion: String(row.tool_version || ''),
    ...(positive(row.fps) ? { fpsTier: Number(row.fps) > 60 ? 'gt60' : Number(row.fps) > 30 ? 'gt30' : 'lte30' } : {}),
  };
  let ambiguous = false;
  const find = (channelId: string): Rule | null => {
    const sample = eligible.find(rule => rule.identity.modelId === model && rule.identity.channelId === channelId);
    if (!sample) return null;
    try { return selectPricingRule(eligible, { ...sample.identity, specifications }); }
    catch (error) { if (error instanceof PricingRuleConflict) { ambiguous = true; return null; } throw error; }
  };
  let rule = channel ? find(channel) : null;
  const routed = basis.qualityRoutes[model]?.[quality];
  if (!rule && routed) rule = find(routed);
  let source: AccountingCost['source'] = 'current_rate';
  if (!rule) {
    const exact = Array.from(new Set(eligible.filter(item => item.identity.modelId === model).map(item => item.identity.channelId)))
      .map(find).filter((item): item is Rule => !!item);
    if (exact.length === 1 || exact.length > 1 && new Set(exact.map(item => item.mode === 'free' ? '0' : item.baseCny)).size === 1) rule = exact[0];
  }
  const same = eligible.filter(item => item.identity.modelId === model);
  if (ambiguous) return null;
  if (!rule && same.length) {
    rule = same.find(item => item.id === fallback.ruleId) || (same.length === 1 ? same[0] : null);
    if (rule) source = 'historical_reference';
  }
  if (!rule) {
    const mapped = basis.settings.models.find(item => item.kind === kind && item.model === model);
    rule = mapped ? eligible.find(item => item.id === mapped.ruleId) || null : null;
    if (rule) source = 'historical_reference';
  }
  if (!rule) { rule = eligible.find(item => item.id === fallback.ruleId) || null; source = 'type_default'; }
  if (rule && channel && rule.identity.channelId !== channel) source = 'historical_reference';
  let unit: 'image' | 'second' | 'call' = rule ? rule.identity.unit === 'image' ? 'image' : 'second' : fallback.unit;
  let base = rule ? rule.mode === 'free' ? '0' : rule.baseCny : fallback.amountCny;
  let quantity = unit === 'image' || unit === 'call' ? '1' : positive(row.duration) ? String(row.duration) : fallback.defaultQuantity;
  let estimated = source !== 'current_rate' || unit === 'second' && !positive(row.duration);
  let tokenDetail = '';
  const inputTokens = usageInteger(row.input_tokens), outputTokens = usageInteger(row.output_tokens);
  if (kind === 'text' && inputTokens !== null && inputTokens >= BigInt(0) && outputTokens !== null && outputTokens >= BigInt(0)
    && fallback.tokenInputCny != null && fallback.tokenOutputCny != null) {
    base = sumDecimal([divideDecimal(multiplyDecimal([inputTokens.toString(), fallback.tokenInputCny]), '1000000', 8),
      divideDecimal(multiplyDecimal([outputTokens.toString(), fallback.tokenOutputCny]), '1000000', 8)]);
    quantity = '1'; unit = 'call'; estimated = false;
    tokenDetail = `输入${row.input_tokens}×¥${fallback.tokenInputCny}/百万token＋输出${row.output_tokens}×¥${fallback.tokenOutputCny}/百万token`;
  }
  if (base === null || !/^\d+(?:\.\d{1,8})?$/.test(base) || !positive(quantity)) return null;
  const exactCny = multiplyDecimal([base, quantity]), micros = usageDecimalUnits(exactCny, 6);
  if (micros === null) return null;
  const rate = rule && rule.mode !== 'free' ? rule.mode === 'follow' ? basis.standards?.[rule.basisKind] ?? basis.pointsPerCny
    : rule.customPointsPerCny || basis.pointsPerCny : basis.pointsPerCny;
  const included = fact.outputCount > 0 && ['succeeded', 'completed', 'received', 'adopted', 'recorded'].includes(fact.status);
  const unitLabel = unit === 'image' ? '张' : unit === 'second' ? '秒' : '次';
  return { amountCnyMicros: micros.toString(), source, revision: basis.revision,
    unitCny: base, unit, quantity, ruleId: rule?.id || null, mappingRevision: basis.settings.revision,
    ...(rate && positive(rate) ? { points: roundDecimal(multiplyDecimal([exactCny, rate]), rule?.rounding === 'half_up_integer' ? 0 : 1, 'half_up'), pointsPerCny: rate } : {}),
    included, estimated,
    detail: `${estimated ? '历史参考折算' : '当前费率'}：${tokenDetail || `¥${base} × ${quantity}${unitLabel}`}；${included ? '计入当前价核算' : '仅参考标价，不计入已发生费用'}；非历史实扣${kind === 'h3' ? '，不含算力分摊' : ''}` };
}

export async function attachAccountingCosts(db: UsageDb, items: Array<{ fact: UsageFact; raw: AccountingRow }>) {
  if (!items.some(({ fact }) => fact.leaf)) return;
  const basis = await readCurrentRateBasis(db);
  for (const { fact, raw } of items) if (fact.leaf) {
    const quote = calculateRateCost(fact, raw, basis);
    if (quote) fact.accountingCost = quote;
  }
}
