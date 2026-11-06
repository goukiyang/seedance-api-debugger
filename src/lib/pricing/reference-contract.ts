import type { PricingPolicy } from './types';
import { normalizeDecimal } from './math';

export const REFERENCE_PRICING_KEY = 'usage_reference_pricing_v1';
export const REFERENCE_PRICING_KINDS = ['image', 'video', 'enhance', 'h3', 'text', 'cutout'] as const;
export type ReferencePricingKind = 'image' | 'video' | 'enhance' | 'h3' | 'text' | 'cutout';
export type ReferencePriceChoice = {
  ruleId: string | null;
  amountCny: string | null;
  unit: 'image' | 'second' | 'call';
  defaultQuantity: string;
  tokenInputCny?: string | null;
  tokenOutputCny?: string | null;
};
export type ReferencePricingSettings = {
  schemaVersion: 1;
  revision: string;
  defaults: Record<ReferencePricingKind, ReferencePriceChoice>;
  models: Array<{ kind: ReferencePricingKind; model: string; ruleId: string }>;
};
export type ReferencePricingRule = {
  id: string; label: string; kind: ReferencePricingKind; model: string;
  unit: ReferencePriceChoice['unit']; baseCny: string;
  pointsPerCny?: string | null;
  rounding?: 'half_up_integer';
};
export type ReferencePricingSnapshot = {
  settings: ReferencePricingSettings;
  rules: ReferencePricingRule[];
  policyRevision: string;
  pointsPerCny: string | null;
};
export type ReferencePricingOperation = {
  requestId: string;
  state: 'succeeded' | 'rejected' | 'unknown';
  settings: ReferencePricingSettings | null;
  error: string | null;
};

function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('历史参考标价格式无效');
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('历史参考标价文字无效');
  return value;
}

export function parseReferenceSettings(raw: unknown): ReferencePricingSettings {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  object(value, ['schemaVersion', 'revision', 'defaults', 'models']);
  if (value.schemaVersion !== 1) throw new Error('历史参考标价版本无效');
  const revision = text(value.revision, 160);
  object(value.defaults, REFERENCE_PRICING_KINDS);
  const defaults = {} as ReferencePricingSettings['defaults'];
  for (const kind of REFERENCE_PRICING_KINDS) {
    const choice = value.defaults[kind];
    object(choice, ['ruleId', 'amountCny', 'unit', 'defaultQuantity', ...(kind === 'text' ? ['tokenInputCny', 'tokenOutputCny'] : [])]);
    const unit = choice.unit;
    if (!(kind === 'image' ? unit === 'image' : kind === 'video' || kind === 'enhance' ? unit === 'second'
      : kind === 'h3' ? unit === 'second' || unit === 'call' : unit === 'call')) {
      throw new Error('历史参考标价单位与类型不符');
    }
    const ruleId = choice.ruleId === null ? null : text(choice.ruleId, 160);
    const amountCny = choice.amountCny === null ? null : normalizeDecimal(choice.amountCny, { maxScale: 8, max: '1000000' });
    if (ruleId !== null && amountCny !== null) throw new Error('规则引用和手填参考价不能同时设置');
    const defaultQuantity = normalizeDecimal(choice.defaultQuantity, { maxScale: 8, max: '10000000', allowZero: false });
    if (unit !== 'second' && defaultQuantity !== '1') throw new Error('按张或按次的参考数量必须为 1');
    defaults[kind] = { ruleId, amountCny, unit: unit as ReferencePriceChoice['unit'], defaultQuantity };
    for (const field of ['tokenInputCny', 'tokenOutputCny'] as const) {
      if (Object.hasOwn(choice, field)) defaults[kind][field] = choice[field] === null ? null : normalizeDecimal(choice[field], { maxScale: 8, max: '1000000' });
    }
  }
  if (!Array.isArray(value.models) || value.models.length > 2000) throw new Error('旧型号映射无效');
  const seen = new Set<string>();
  const models = value.models.map(item => {
    object(item, ['kind', 'model', 'ruleId']);
    if (!REFERENCE_PRICING_KINDS.includes(item.kind as ReferencePricingKind)) throw new Error('旧型号类型无效');
    const kind = item.kind as ReferencePricingKind, model = text(item.model, 500), ruleId = text(item.ruleId, 160);
    const key = `${kind}:${model}`;
    if (seen.has(key)) throw new Error('同类型旧型号不能重复映射');
    seen.add(key);
    return { kind, model, ruleId };
  });
  return { schemaVersion: 1, revision, defaults, models };
}

export function getDefaultReferenceSettings(policy: PricingPolicy): ReferencePricingSettings {
  const rules = policy.rules.filter(rule => rule.identity.billingMode === 'fixed'
    && (rule.mode === 'free' || ['follow', 'custom'].includes(rule.mode) && rule.baseCny !== null && !!rule.source?.confirmedAt))
    .slice().sort((a, b) => Object.keys(a.identity.specifications).length - Object.keys(b.identity.specifications).length || a.id.localeCompare(b.id));
  const defaults = {} as ReferencePricingSettings['defaults'];
  for (const kind of REFERENCE_PRICING_KINDS) {
    const rule = ['image', 'video', 'enhance'].includes(kind) ? rules.find(item => item.identity.kind === kind) : undefined;
    defaults[kind] = { ruleId: rule?.id ?? null, amountCny: kind === 'h3' ? '0' : null,
      unit: kind === 'image' ? 'image' : kind === 'video' || kind === 'enhance' ? 'second' : 'call', defaultQuantity: kind === 'video' ? '5' : '1' };
  }
  defaults.text.tokenInputCny = null;
  defaults.text.tokenOutputCny = null;
  const models: ReferencePricingSettings['models'] = [];
  for (const [model, current] of [['gemini-3.1-flash-image-preview', 'gemini-nano-banana-2.1'], ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']]) {
    const rule = rules.find(item => item.identity.kind === 'image' && item.identity.modelId === current);
    if (rule) models.push({ kind: 'image', model, ruleId: rule.id });
  }
  // H3's explicit free_local API contract excludes workstation costs.
  return { schemaVersion: 1, revision: `unconfigured:${policy.revision}`, defaults, models };
}
