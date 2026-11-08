import type { PricingAdminIdentity, PricingAdminRow } from './admin-contract';
import { selectPricingRule } from './resolve';

export const MODEL_ACCESS_KEY = 'pricing_model_access_v1';
export type SupplementaryModelKind = 'text' | 'cutout';
export type ModelAccessSettings = {
  version: 1;
  revision: string;
  models: Array<{ kind: SupplementaryModelKind; model: string; enabled: boolean }>;
};
export type PricingModelAvailability = {
  revision: string;
  menuRevision?: string;
  rows: Array<{ id: string; identity: PricingAdminIdentity; available: boolean }>;
  supplementary: ModelAccessSettings;
};

export function parseModelAccessSettings(raw: string | null): ModelAccessSettings {
  if (raw === null) return { version: 1, revision: 'unconfigured', models: [] };
  const value = JSON.parse(raw) as ModelAccessSettings;
  if (!value || value.version !== 1 || typeof value.revision !== 'string' || !value.revision
    || Object.keys(value).some(key => !['version', 'revision', 'models'].includes(key))
    || !Array.isArray(value.models) || value.models.length > 100
    || value.models.some(item => !item || !['text', 'cutout'].includes(item.kind)
      || typeof item.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(item.model)
      || typeof item.enabled !== 'boolean' || Object.keys(item).some(key => !['kind', 'model', 'enabled'].includes(key)))
    || new Set(value.models.map(item => `${item.kind}:${item.model}`)).size !== value.models.length) {
    throw new Error('模型开放设置无法读取，请重新读取；未按默认开启覆盖');
  }
  return value;
}

export function supplementaryModelEnabled(settings: ModelAccessSettings, kind: SupplementaryModelKind, model: string) {
  // Existing services retain their own billing and admission contract until explicitly switched here.
  return settings.models.find(item => item.kind === kind && item.model === model)?.enabled !== false
    && settings.models.find(item => item.kind === kind && item.model === 'all')?.enabled !== false;
}

export function projectPricingModelAvailability(rows: Array<Pick<PricingAdminRow, 'id' | 'identity' | 'pricingEnabled' | 'mode' | 'enabled' | 'availability'>>, revision: string,
  supplementary: ModelAccessSettings): PricingModelAvailability {
  return { revision, supplementary, rows: rows.map(row => ({ id: row.id, identity: row.identity,
    available: row.pricingEnabled !== false && row.mode !== 'unset' && row.enabled && row.availability === 'ready' })) };
}

/** An enabled real specification keeps a model visible; an exact disabled rule still wins. */
export function pricingModelAvailable(snapshot: PricingModelAvailability | null, kind: PricingAdminIdentity['kind'] | SupplementaryModelKind,
  model: string, specifications: Record<string, string> = {}, channelId?: string): boolean {
  if (!snapshot || !model) return false;
  if (kind === 'text' || kind === 'cutout') return supplementaryModelEnabled(snapshot.supplementary, kind, model);
  const rows = snapshot.rows.filter(row => row.identity.kind === kind && row.identity.modelId === model
    && (!channelId || row.identity.channelId === channelId));
  return rows.some(row => {
    if (Object.entries(specifications).some(([key, value]) => row.identity.specifications[key] !== undefined
      && row.identity.specifications[key] !== value)) return false;
    const identity = { ...row.identity, specifications: { ...row.identity.specifications, ...specifications } };
    return selectPricingRule(rows, identity)?.available === true;
  });
}
