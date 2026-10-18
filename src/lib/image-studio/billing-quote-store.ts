import type { Prisma } from '@prisma/client';
import type { ImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation-channel';
import { parseImageBillingContract, type ImageBillingContract } from './billing-contract';
import { imageBillingReady } from './billing-readiness';
import type { SharedStudioIntent } from './shared-types';
import { assertNewPricingCharge } from '@/lib/pricing/charge';

export const imageQuoteKey = (owner: string, id: string) => `image_billing_quote_v1:${owner}:${id}`;
export type StoredImageQuote = { owner: string; count: number; fingerprint: string; intentRevision: number; contract: ImageBillingContract; imageChannel?: ImageGenerationChannelSnapshot; sharedLive?: SharedStudioIntent };
export async function consumeImageQuote(tx: Prisma.TransactionClient, input: { owner: string; id: string;
  count: number; fingerprint: string; specification: string; scope: string; model: string; imageChannel?: ImageGenerationChannelSnapshot; sharedLive?: SharedStudioIntent }) {
  const row = await tx.platformSetting.findUnique({ where: { key: imageQuoteKey(input.owner, input.id) } });
  if (!row) throw new Error('Image quote unavailable');
  const quote = JSON.parse(row.value_json) as StoredImageQuote;
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
  const sameDefinition = quote.sharedLive === undefined && input.sharedLive === undefined
    || Boolean(quote.sharedLive && input.sharedLive && quote.sharedLive.protocol === 'shared-live-v1'
      && quote.sharedLive.protocol === input.sharedLive.protocol && quote.sharedLive.presetId === input.sharedLive.presetId
      && quote.sharedLive.definitionToken === input.sharedLive.definitionToken);
  if (!contract || contract.mode !== 'actual' && !contract.pricing || quote.owner !== input.owner || quote.count !== input.count
    || quote.fingerprint !== input.fingerprint || contract.scope !== input.scope || contract.model !== input.model
    || contract.specification !== input.specification || Date.parse(contract.expiresAt) <= Date.now()
    || !validSavedChannel || !sameChannel || !sameDefinition
    || contract.mode === 'actual' && (!state.ready || state.intentRevision !== quote.intentRevision)) throw new Error('Image quote expired or changed');
  if (contract.pricing) await assertNewPricingCharge(contract.pricing, contract.pricing.revision, tx);
  const removed = await tx.platformSetting.deleteMany({ where: { id: row.id, value_json: row.value_json } });
  if (removed.count !== 1) throw new Error('Image quote already consumed');
  return contract;
}
