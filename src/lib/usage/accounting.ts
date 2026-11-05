import { Prisma } from '@prisma/client';
import type { UsageFact } from '@/lib/admin/usage-types';
import { usageCnyMicros, usageDecimalUnits, usageInteger } from '@/lib/admin/usage-money';
import { estimateNormalVideoCharge, loadNormalVideoChargeRates, type NormalChargeBill } from '@/lib/costs/normal-video-charge';
import type { PricingAdminIdentity } from '@/lib/pricing/admin-contract';
import { multiplyDecimal } from '@/lib/pricing/math';
import { PricingRuleConflict, selectPricingRule } from '@/lib/pricing/resolve';
import type { UsageDb } from './database';

export type AccountingCost = { amountCnyMicros: string; source: 'asset' | 'asset_rate' | 'frozen_rate' | 'current_rate'; detail: string; revision: string | null };
export type AccountingRow = Record<string, string | number | bigint | Date | boolean | null>;
type Rule = { id: string; identity: PricingAdminIdentity; mode: string; baseCny: string | null };
type Basis = { revision: string | null; rules: Rule[]; qualityRoutes: Record<string, Record<string, string>> };
const contexts = new WeakMap<UsageDb, Promise<Basis>>();
const videoRates = new WeakMap<UsageDb, ReturnType<typeof loadNormalVideoChargeRates>>();

async function accountingBasis(db: UsageDb): Promise<Basis> {
  let context = contexts.get(db);
  if (!context) {
    context = (async () => {
      // Only public monetary policy fields cross the read-snapshot boundary.
      const rows = await db.$queryRaw<Array<{ revision: string; id: string; identity: string; mode: string; baseCny: string | null }>>(Prisma.sql`
        SELECT json_extract(p.value_json, '$.revision') AS revision, json_extract(r.value, '$.id') AS id,
          json_extract(r.value, '$.identity') AS identity, json_extract(r.value, '$.mode') AS mode,
          json_extract(r.value, '$.baseCny') AS baseCny
        FROM PlatformSetting p, json_each(CASE WHEN json_valid(p.value_json) THEN p.value_json ELSE '{}' END, '$.rules') r
        WHERE p.key = 'pricing_policy_v1' AND json_extract(p.value_json, '$.schemaVersion') = 1
          AND (json_extract(r.value, '$.source.confirmedAt') IS NOT NULL OR json_extract(r.value, '$.mode') = 'free')`);
      const defaults = await db.$queryRaw<Array<{ routes: string | null }>>(Prisma.sql`SELECT
        json_extract(CASE WHEN json_valid(value_json) THEN value_json ELSE '{}' END, '$.qualityRoutes') AS routes
        FROM PlatformSetting WHERE key = 'image_generation_model_defaults_v1'`);
      const rules = rows.map(row => ({ id: row.id, identity: JSON.parse(row.identity) as PricingAdminIdentity, mode: row.mode, baseCny: row.baseCny }));
      if (rules.some(rule => !rule.identity || typeof rule.identity.modelId !== 'string' || !rule.identity.specifications
        || rule.baseCny !== null && !/^\d+(?:\.\d{1,8})?$/.test(rule.baseCny))) throw new Error('usage_accounting_policy_invalid');
      return { revision: rows[0]?.revision || null, rules, qualityRoutes: defaults[0]?.routes ? JSON.parse(defaults[0].routes) : {} };
    })();
    contexts.set(db, context);
  }
  return context;
}

async function assetRates(db: UsageDb) {
  let rates = videoRates.get(db);
  if (!rates) {
    const groups = ['dreamina-seedance-2-0-260128', 'dreamina-seedance-2-5-260628'].flatMap(model => [false, true].map(referenceVideo => ({
      model, provider: 'seedance', is_draft: false, reference_video_urls: referenceVideo ? '["reference"]' : null,
    })));
    rates = loadNormalVideoChargeRates(groups, async group => {
      const bills = await db.$queryRaw<NormalChargeBill[]>(Prisma.sql`SELECT
      provider, model, is_draft,
      CASE WHEN reference_video_urls IS NOT NULL AND trim(reference_video_urls) NOT IN ('', '[]') THEN '["reference"]' ELSE NULL END AS reference_video_urls,
      provider_final_amount_micros, provider_official_amount_micros, provider_final_amount_minor, provider_official_amount_minor,
      json_object('completion_tokens', json_extract(CASE WHEN json_valid(provider_usage_snapshot) THEN provider_usage_snapshot ELSE '{}' END, '$.completion_tokens')) AS provider_usage_snapshot,
      json_object('source', json_extract(CASE WHEN json_valid(provider_cost_snapshot) THEN provider_cost_snapshot ELSE '{}' END, '$.source')) AS provider_cost_snapshot
      FROM VideoTask WHERE provider = 'seedance' AND model = ${group.model} AND is_draft = 0 AND local_status = 'succeeded'
        AND provider_cost_currency = 'USD' AND provider_cost_status IN ('official_confirmed', 'reconciled') AND provider_usage_snapshot IS NOT NULL
        AND ${group.referenceVideo ? Prisma.sql`reference_video_urls IS NOT NULL AND reference_video_urls NOT IN ('', '[]')`
          : Prisma.sql`(reference_video_urls IS NULL OR reference_video_urls IN ('', '[]'))`}
      ORDER BY provider_cost_confirmed_at DESC, created_at DESC LIMIT 8`);
      // The read-only SQLite protocol preserves INTEGER as bigint, whereas the
      // asset helper receives bounded Prisma Ints. Normalize at this boundary.
      for (const bill of bills) for (const key of ['provider_final_amount_micros', 'provider_official_amount_micros', 'provider_final_amount_minor', 'provider_official_amount_minor'] as const) {
        if (bill[key] !== null) bill[key] = Number(bill[key]);
      }
      return bills;
    });
    videoRates.set(db, rates);
  }
  return rates;
}

export function calculateRateCost(fact: UsageFact, row: AccountingRow, basis: Basis): AccountingCost | null {
  if (fact.status !== 'succeeded' || !fact.outputCount) return null;
  const model = fact.model || '';
  const image = fact.sourceKind === 'image_task';
  const quantity = image ? '1' : String(row.frozen_quantity ?? row.duration ?? '');
  if (!/^\d+(?:\.\d{1,8})?$/.test(quantity) || Number(quantity) <= 0) return null;
  // Frozen points and actual-bill reservations are not monetary cost evidence.
  if (row.frozen_billing_mode === 'fixed' && ['follow', 'custom', 'free'].includes(String(row.frozen_mode))) {
    const base = row.frozen_mode === 'free' ? '0' : row.frozen_base;
    if (typeof base === 'string' && /^\d+(?:\.\d{1,8})?$/.test(base)) {
      const amount = usageDecimalUnits(multiplyDecimal([base, quantity]), 6);
      if (amount !== null) return { amountCnyMicros: amount.toString(), source: 'frozen_rate', revision: String(row.frozen_revision || ''), detail: `任务冻结费率：¥${base} × ${quantity}${image ? ' 张' : ' 秒'}` };
    }
  }
  if (row.is_draft || row.is_upgrade || !image && !['seedance', 'volcengine_ark', 'volcengine_mediakit'].includes(String(row.provider))) return null;
  const quality = String(row.quality || '');
  const historicalChannel = typeof row.channel_id === 'string' ? row.channel_id : null;
  const channel = image ? historicalChannel || basis.qualityRoutes[model]?.[quality] : String(row.provider);
  const kind = image ? 'image' : row.provider === 'volcengine_mediakit' ? 'enhance' : 'video';
  const specifications: Record<string, string> = image ? { quality, resolution: String(row.output_size || '') } : {
    resolution: String(row.resolution || ''), referenceVideo: row.reference_video_urls ? 'present' : 'none', pricingPurpose: 'standard',
    toolVersion: String(row.tool_version || ''), fpsTier: Number(row.fps) > 60 ? 'gt60' : Number(row.fps) > 30 ? 'gt30' : 'lte30',
  };
  const candidates = basis.rules.filter(rule => rule.identity.kind === kind && rule.identity.modelId === model
    && rule.identity.billingMode === 'fixed' && (!channel || rule.identity.channelId === channel));
  const selected: Rule[] = [];
  for (const channelId of Array.from(new Set(candidates.map(rule => rule.identity.channelId)))) {
    try {
      const rule = selectPricingRule(candidates, { kind, channelId, modelId: model, billingMode: 'fixed', unit: image ? 'image' : 'second', specifications });
      if (rule) selected.push(rule);
    } catch (error) { if (error instanceof PricingRuleConflict) return null; throw error; }
  }
  const amounts = selected.map(rule => rule.mode === 'free' ? '0' : ['follow', 'custom'].includes(rule.mode) ? rule.baseCny : null);
  if (!amounts.length || amounts.some(amount => amount === null) || new Set(amounts).size !== 1) return null;
  const amount = usageDecimalUnits(multiplyDecimal([amounts[0]!, quantity]), 6);
  return amount === null ? null : { amountCnyMicros: amount.toString(), source: 'current_rate', revision: basis.revision,
    detail: `当前已确认费率：¥${amounts[0]} × ${quantity}${image ? ' 张' : ' 秒'}；非供应商实扣` };
}

export async function attachAccountingCosts(db: UsageDb, items: Array<{ fact: UsageFact; raw: AccountingRow }>) {
  const missing = items.filter(({ fact }) => fact.leaf && ['video_task', 'image_task'].includes(fact.sourceKind)
    && fact.status === 'succeeded' && fact.outputCount > 0 && fact.costStatus !== 'conflict' && fact.confirmedCost.length === 0);
  if (!missing.length) return;
  const basis = await accountingBasis(db);
  const rates = missing.some(({ fact }) => fact.sourceKind === 'video_task') ? await assetRates(db) : new Map<string, number>();
  for (const { fact, raw } of missing) {
    let cost: AccountingCost | null = null;
    if (fact.sourceKind === 'video_task') {
      const micros = usageInteger(raw.provider_final_amount_micros ?? raw.provider_official_amount_micros);
      const minor = usageInteger(raw.provider_final_amount_minor ?? raw.provider_official_amount_minor);
      const amount = micros ?? (minor === null ? null : minor * BigInt(10000));
      const cny = amount !== null && amount >= BigInt(0) ? usageCnyMicros([{ currency: String(raw.provider_cost_currency), amountMicros: amount.toString() }]) : null;
      if (cny !== null) cost = { amountCnyMicros: cny, source: 'asset', revision: null, detail: '资产管理已记录金额；供应商原账证明仍单独保留' };
      else {
        const estimate = estimateNormalVideoCharge({ provider: String(raw.provider), model: fact.model || '', is_draft: Boolean(raw.is_draft),
          reference_video_urls: raw.reference_video_urls as string | null, provider_usage_snapshot: raw.provider_usage_snapshot as string | null,
          raw_status_response: raw.raw_status_response as string | null }, rates);
        const amount = estimate ? usageCnyMicros([{ currency: estimate.currency, amountMicros: String(estimate.amountMicros) }]) : null;
        if (estimate && amount !== null) cost = { amountCnyMicros: amount, source: 'asset_rate', revision: null,
          detail: `资产管理同口径：${estimate.completionTokens} completion tokens × US$${estimate.usdPerMillionTokens}/百万 tokens；非供应商实扣` };
      }
    }
    cost ||= calculateRateCost(fact, raw, basis);
    if (cost) { fact.accountingCost = cost; fact.costStatus = 'calculated'; }
  }
}
