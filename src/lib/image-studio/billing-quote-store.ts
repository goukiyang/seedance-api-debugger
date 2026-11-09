import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { ImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation-channel';
import { parseImageBillingContract, type ImageBillingContract } from './billing-contract';
import { imageBillingReady } from './billing-readiness';
import type { SharedStudioIntent } from './shared-types';
import { assertNewPricingCharge } from '@/lib/pricing/charge';
import { CURRENT_STUDIO_SIZE_POLICY_VERSION, type StudioSizePolicyVersion } from './ratios';

export const imageQuoteKey = (owner: string, id: string) => `image_billing_quote_v1:${owner}:${id}`;
export type StoredImageQuote = { owner: string; count: number; fingerprint: string; intentRevision: number; contract: ImageBillingContract; sizePolicyVersion?: StudioSizePolicyVersion; imageChannel?: ImageGenerationChannelSnapshot; sharedLive?: SharedStudioIntent };

/** Preview rows are disposable; accepted tasks keep their own frozen contract and consume this row in the same transaction. */
export async function cleanupExpiredImageQuotePreviews(owner: string,
  client: Pick<Prisma.TransactionClient, '$queryRaw' | 'platformSetting'> = prisma,
  options: { now?: number; limit?: number } = {}) {
  const now = options.now ?? Date.now();
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 32)));
  const prefix = imageQuoteKey(owner, '');
  const rows = await client.$queryRaw<Array<{ id: string; key: string; value_json: string }>>(Prisma.sql`
    WITH previews AS (
      SELECT id, key, value_json, CASE WHEN json_valid(value_json) THEN value_json ELSE '{}' END AS value
      FROM PlatformSetting WHERE key >= ${prefix} AND key < ${`${prefix}\uffff`}
    )
    SELECT id, key, value_json FROM previews
    WHERE json_type(value, '$.contract.expiresAt') = 'text'
      AND julianday(json_extract(value, '$.contract.expiresAt')) <= julianday(${new Date(now).toISOString()})
    ORDER BY julianday(json_extract(value, '$.contract.expiresAt')), key LIMIT ${limit}
  `);
  const expired = rows.filter(row => {
    try {
      const id = row.key.slice(prefix.length);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return false;
      const value = JSON.parse(row.value_json) as StoredImageQuote;
      const contract = parseImageBillingContract(JSON.stringify(value.contract));
      return contract !== null && value.owner === owner && Number.isSafeInteger(value.count) && value.count > 0
        && value.fingerprint === contract?.specification && Date.parse(contract.expiresAt) <= now;
    } catch { return false; }
  });
  if (!expired.length) return { scanned: rows.length, deleted: 0 };
  const removed = await client.platformSetting.deleteMany({ where: { OR: expired.map(row => ({
    id: row.id, key: row.key, value_json: row.value_json,
  })) } });
  return { scanned: rows.length, deleted: removed.count };
}

export async function consumeImageQuote(tx: Prisma.TransactionClient, input: { owner: string; id: string;
  count: number; fingerprint: string; specification: string; scope: string; model: string; sizePolicyVersion?: StudioSizePolicyVersion; imageChannel?: ImageGenerationChannelSnapshot; sharedLive?: SharedStudioIntent }) {
  const row = await tx.platformSetting.findUnique({ where: { key: imageQuoteKey(input.owner, input.id) } });
  if (!row) throw new Error('Image quote unavailable');
  const quote = JSON.parse(row.value_json) as StoredImageQuote;
  if (quote.sizePolicyVersion !== CURRENT_STUDIO_SIZE_POLICY_VERSION
    || quote.sizePolicyVersion !== (input.sizePolicyVersion ?? CURRENT_STUDIO_SIZE_POLICY_VERSION)) {
    throw new Error('Image size policy changed; request a new quote');
  }
  const contract = parseImageBillingContract(JSON.stringify(quote.contract));
  const state = await imageBillingReady(input.scope, input.model, tx);
  const savedChannel = quote.imageChannel;
  const validSavedChannel = !savedChannel || typeof savedChannel.channelId === 'string'
    && savedChannel.channelId.length > 0 && savedChannel.channelId.length <= 80
    && typeof savedChannel.configRevision === 'string' && /^[0-9a-f-]{36}$/i.test(savedChannel.configRevision);
  const sameChannel = savedChannel === undefined && input.imageChannel === undefined
    || Boolean(savedChannel && input.imageChannel && validSavedChannel
      && savedChannel.channelId === input.imageChannel.channelId
      && savedChannel.configRevision === input.imageChannel.configRevision);
  const sameQualityRoute = JSON.stringify(savedChannel?.qualityRoute) === JSON.stringify(input.imageChannel?.qualityRoute);
  const sameDefinition = quote.sharedLive === undefined && input.sharedLive === undefined
    || Boolean(quote.sharedLive && input.sharedLive && quote.sharedLive.protocol === 'shared-live-v1'
      && quote.sharedLive.protocol === input.sharedLive.protocol && quote.sharedLive.presetId === input.sharedLive.presetId
      && quote.sharedLive.definitionToken === input.sharedLive.definitionToken);
  if (!contract || contract.mode !== 'actual' && !contract.pricing || quote.owner !== input.owner || quote.count !== input.count
    || quote.fingerprint !== input.fingerprint || contract.scope !== input.scope || contract.model !== input.model
    || contract.specification !== input.specification || Date.parse(contract.expiresAt) <= Date.now()
    || !validSavedChannel || !sameChannel || !sameQualityRoute || !sameDefinition
    || contract.mode === 'actual' && (!state.ready || state.intentRevision !== quote.intentRevision)) throw new Error('Image quote expired or changed');
  if (contract.pricing) await assertNewPricingCharge(contract.pricing, contract.pricing.revision, tx);
  const removed = await tx.platformSetting.deleteMany({ where: { id: row.id, value_json: row.value_json } });
  if (removed.count !== 1) throw new Error('Image quote already consumed');
  return contract;
}
