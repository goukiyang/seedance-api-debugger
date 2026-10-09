import { imageBillingScope } from './billing-scope';
import type { ImageGenerationApiSettings } from '@/lib/integrations/image-generation';

export type ImageSupplierCharge = { requestId: string; model: string; amountMicros: number; occurredAt: Date;
  quota: number; promptTokens: number | null; completionTokens: number | null; type: number;
  parameters?: Partial<Record<'model_price' | 'model_ratio' | 'group_ratio' | 'completion_ratio' | 'image_ratio', number>> };

const origin = 'https://api.muskapis.com';
export function parseImageSupplierBills(body: unknown) {
  if (!body || typeof body !== 'object' || (body as { success?: unknown }).success !== true) throw new Error('Supplier billing unavailable');
  let data = (body as { data?: unknown }).data;
  if (data && typeof data === 'object' && !Array.isArray(data)) data = (data as { items?: unknown }).items;
  if (!Array.isArray(data) || data.length > 10000) throw new Error('Supplier billing window unavailable');
  const rows: ImageSupplierCharge[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (row.type !== 2 && row.type !== 6) continue;
    if (typeof row.request_id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(row.request_id)
      || typeof row.model_name !== 'string' || row.model_name.length > 128) continue;
    // Invalid consumption is kept as a conflict sentinel, never filtered into
    // a false zero-dollar match. The list's display id is deliberately ignored.
    const quota = typeof row.quota === 'number' && Number.isSafeInteger(row.quota) ? row.quota : -1;
    const at = typeof row.created_at === 'number' && Number.isSafeInteger(row.created_at) ? row.created_at * 1000 : NaN;
    let extra: unknown = row.other;
    try { if (typeof extra === 'string') extra = JSON.parse(extra); } catch { extra = null; }
    const parameters: ImageSupplierCharge['parameters'] = {};
    if (extra && typeof extra === 'object') for (const name of ['model_price', 'model_ratio', 'group_ratio', 'completion_ratio', 'image_ratio'] as const) {
      const number = (extra as Record<string, unknown>)[name];
      if (typeof number === 'number' && Number.isFinite(number) && number >= -1 && number <= 100000) parameters[name] = number;
    }
    rows.push({ requestId: row.request_id, model: row.model_name,
      amountMicros: quota >= 0 && quota <= 1_000_000_000 ? quota * 2 : -1,
      quota, occurredAt: new Date(at), type: row.type as number, parameters,
      promptTokens: typeof row.prompt_tokens === 'number' && Number.isSafeInteger(row.prompt_tokens) && row.prompt_tokens >= 0 ? row.prompt_tokens : null,
      completionTokens: typeof row.completion_tokens === 'number' && Number.isSafeInteger(row.completion_tokens) && row.completion_tokens >= 0 ? row.completion_tokens : null });
  }
  return rows;
}

export function matchImageSupplierCharge(rows: ImageSupplierCharge[], requestId: string, model: string) {
  const matches = rows.filter(row => row.requestId === requestId);
  if (!matches.length) return { state: 'missing' as const };
  if (matches.length !== 1 || matches[0].type !== 2 || matches[0].model !== model
    || matches[0].amountMicros < 0 || !Number.isFinite(matches[0].occurredAt.getTime())) return { state: 'conflict' as const };
  return { state: 'matched' as const, charge: matches[0] };
}

async function readBoundedJson(url: string, key?: string) {
  const response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(10000) });
  if (!response.ok || !response.body) throw new Error('Supplier billing unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 8_000_000) throw new Error('Supplier billing response too large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => {}); }
}

const cache = new Map<string, { expires: number; work: Promise<ImageSupplierCharge[]> }>();
export async function readImageSupplierBills(settings: ImageGenerationApiSettings, scope: string) {
  const base = new URL(settings.base_url);
  if (settings.provider !== 'musk' || base.origin !== origin || imageBillingScope(settings) !== scope) throw new Error('Supplier scope changed');
  const previous = cache.get(scope);
  if (previous && previous.expires > Date.now()) return previous.work;
  if (cache.size >= 4 && !cache.has(scope)) cache.delete(cache.keys().next().value!);
  const work = fetchImageSupplierBills(settings);
  cache.set(scope, { expires: Date.now() + 30000, work });
  try { return await work; } catch (error) { if (cache.get(scope)?.work === work) cache.delete(scope); throw error; }
}

async function fetchImageSupplierBills(settings: ImageGenerationApiSettings) {
  const status = await readBoundedJson(`${origin}/api/status`) as { data?: { quota_per_unit?: unknown; quota_display_type?: unknown } };
  if (status.data?.quota_per_unit !== 500000 || status.data.quota_display_type !== 'USD') throw new Error('Supplier currency or quota unit changed');
  // This provider ignores request_id filters. Fetch once per scope and match
  // locally; GET response headers are never a generation billing identity.
  return parseImageSupplierBills(await readBoundedJson(`${origin}/api/log/token`, settings.api_key!));
}
