import { prisma } from '@/lib/prisma';

export type NormalVideoChargeEstimate = {
  amountMicros: number;
  currency: 'USD';
  completionTokens: number;
  usdPerMillionTokens: number;
};

type ChargeTask = {
  provider: string;
  model: string;
  reference_video_urls: string | null;
  is_draft: boolean;
};
type ChargeGroup = { model: string; referenceVideo: boolean; key: string };

function objectFromJson(value: string | null) {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function chargeGroup(task: ChargeTask): ChargeGroup | null {
  if (!['seedance', 'volcengine_ark'].includes(task.provider) || task.is_draft) return null;
  const model = task.model === 'doubao-seedance-2-0-260128' ? 'dreamina-seedance-2-0-260128'
    : task.model === 'doubao-seedance-2-5-260628' ? 'dreamina-seedance-2-5-260628' : task.model;
  if (!['dreamina-seedance-2-0-260128', 'dreamina-seedance-2-5-260628'].includes(model)) return null;
  let referenceVideo = false;
  if (task.reference_video_urls?.trim()) {
    try {
      const urls: unknown = JSON.parse(task.reference_video_urls);
      if (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string')) return null;
      referenceVideo = urls.some((url: string) => Boolean(url.trim()));
    } catch { return null; }
  }
  return { model, referenceVideo, key: `${model}:${referenceVideo}` };
}

export function completionTokensFromSnapshot(usageJson: string | null, statusJson: string | null) {
  const usage = objectFromJson(usageJson);
  const status = objectFromJson(statusJson);
  const data = status?.data;
  const nestedUsage = status?.usage ?? (data && typeof data === 'object' ? (data as Record<string, unknown>).usage : null);
  const tokens = usage?.completion_tokens ?? (nestedUsage && typeof nestedUsage === 'object'
    ? (nestedUsage as Record<string, unknown>).completion_tokens : null);
  return typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

export async function loadNormalVideoChargeRates(tasks: ChargeTask[]) {
  const groups = new Map<string, ChargeGroup>();
  for (const task of tasks) { const group = chargeGroup(task); if (group) groups.set(group.key, group); }
  const rates = new Map<string, number>();
  // Use the latest matching confirmed ordinary bill, not a points-to-cash conversion.
  await Promise.all(Array.from(groups.values()).map(async (group) => {
    const bills = await prisma.videoTask.findMany({
      where: {
        provider: 'seedance', model: group.model, is_draft: false, local_status: 'succeeded',
        provider_cost_currency: 'USD', provider_cost_status: { in: ['official_confirmed', 'reconciled'] },
        provider_usage_snapshot: { not: null },
        ...(group.referenceVideo
          ? { reference_video_urls: { not: null, notIn: ['', '[]'] } }
          : { OR: [{ reference_video_urls: null }, { reference_video_urls: { in: ['', '[]'] } }] }),
      },
      orderBy: [{ provider_cost_confirmed_at: 'desc' }, { created_at: 'desc' }], take: 8,
      select: {
        provider: true, model: true, is_draft: true, reference_video_urls: true,
        provider_final_amount_micros: true, provider_official_amount_micros: true,
        provider_final_amount_minor: true, provider_official_amount_minor: true,
        provider_usage_snapshot: true,
        provider_cost_snapshot: true,
      },
    });
    for (const bill of bills) {
      if (chargeGroup(bill)?.key !== group.key) continue;
      if (objectFromJson(bill.provider_cost_snapshot)?.source !== 'provider_get_result') continue;
      const tokens = completionTokensFromSnapshot(bill.provider_usage_snapshot, null);
      const minor = bill.provider_final_amount_minor ?? bill.provider_official_amount_minor;
      const micros = bill.provider_final_amount_micros ?? bill.provider_official_amount_micros
        ?? (minor !== null ? minor * 10_000 : null);
      if (!tokens || micros === null || !Number.isSafeInteger(micros) || micros <= 0) continue;
      rates.set(group.key, micros / tokens);
      break;
    }
  }));
  return rates;
}

export function estimateNormalVideoCharge(task: ChargeTask & {
  provider_usage_snapshot: string | null;
  raw_status_response: string | null;
}, rates: ReadonlyMap<string, number>): NormalVideoChargeEstimate | null {
  const group = chargeGroup(task);
  const tokens = completionTokensFromSnapshot(task.provider_usage_snapshot, task.raw_status_response);
  const rate = group ? rates.get(group.key) : null;
  if (!tokens || !rate || !Number.isFinite(rate) || rate <= 0) return null;
  const amountMicros = Math.round(tokens * rate);
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) return null;
  return { amountMicros, currency: 'USD', completionTokens: tokens, usdPerMillionTokens: rate };
}
