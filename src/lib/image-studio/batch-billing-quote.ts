import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { prepareImageBillingQuote } from './billing-quote-service';
import { imageQuoteKey, type StoredImageQuote } from './billing-quote-store';
import { parseStudioRequest, StudioError } from './tasks';
import { STUDIO_BATCH_LIMITS } from './batch-contract';
import { parseImageBillingContract, type ImageBillingContract } from './billing-contract';
import { imageBillingReady } from './billing-readiness';

const key = (owner: string, id: string) => `image_batch_billing_quote_v1:${owner}:${id}`;
export function batchQuoteFingerprint(body: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify({ input: parseStudioRequest({ ...body, count: 1, maxEstimatedCost: undefined }),
    moduleId: body.moduleId, sources: body.sources })).digest('hex');
}
export async function quoteStudioBatch(owner: string, body: Record<string, unknown>) {
  const sources = body.sources;
  if (typeof body.moduleId !== 'string' || !Array.isArray(sources) || !sources.length || sources.length > STUDIO_BATCH_LIMITS.images) throw new StudioError('本批素材数量或模板无效');
  const input = parseStudioRequest({ ...body, count: 1, maxEstimatedCost: undefined });
  const batchId = createHash('sha256').update(`${owner}:${input.requestId}`).digest('hex');
  const contracts: Array<ImageBillingContract | null> = [];
  const policy = input.draft?.referencePolicy;
  let total = 0, fixedUnit: number | null = null, intentRevision = 0;
  try {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index] as { name?: unknown; assetId?: unknown };
      if (!source || typeof source.name !== 'string' || source.name.length > 160
        || source.assetId !== undefined && (typeof source.assetId !== 'string' || source.assetId.length > 100)) throw new StudioError('素材清单无效');
      const referenceIds = source.assetId ? [source.assetId as string, ...input.referenceIds.filter(id => !policy?.primaryIds.includes(id))] : input.referenceIds;
      const quote = await prepareImageBillingQuote(owner, { ...body, requestId: `${batchId.slice(0, 48)}-${index + 1}`, count: 1,
        referenceIds, ...(source.assetId && input.draft && policy ? { draft: { ...input.draft, referencePolicy: { ...policy, primaryIds: [source.assetId] } } } : {}) }, undefined, undefined, undefined, 256);
      total += quote.unitCredits;
      fixedUnit = quote.unitCredits;
      if (!quote.billingQuoteId) { contracts.push(null); continue; }
      const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: imageQuoteKey(owner, quote.billingQuoteId) } });
      const stored = JSON.parse(row.value_json) as StoredImageQuote;
      contracts.push(stored.contract); intentRevision = stored.intentRevision;
      await prisma.platformSetting.delete({ where: { id: row.id } });
    }
  } catch (error) { throw error instanceof StudioError ? error : new StudioError('整批报价未确认，未派发生成', 503); }
  if (contracts.every(contract => contract === null)) return { billingMode: 'fixed', batchQuoteId: null,
    unitCredits: fixedUnit, estimatedCredits: total, expiresAt: new Date(Date.now() + 60000).toISOString() };
  if (contracts.some(contract => !contract)) throw new StudioError('批量准备期间计费状态发生变化，请重新报价', 409);
  const id = randomUUID(), expiresAt = new Date(Math.min(...contracts.map(contract => Date.parse(contract!.expiresAt)))).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) throw new StudioError('整批准备超过报价有效期，请重新报价', 409);
  await prisma.platformSetting.deleteMany({ where: { key: { startsWith: `image_batch_billing_quote_v1:${owner}:` },
    created_at: { lt: new Date(Date.now() - 120000) } } });
  await prisma.platformSetting.create({ data: { key: key(owner, id), updated_by: owner,
    value_json: JSON.stringify({ owner, fingerprint: batchQuoteFingerprint(body), intentRevision, contracts,
      expiresAt, total, unitCredits: Math.max(...contracts.map(contract => contract!.authorizedCredits)) }) } });
  return { billingMode: 'actual', batchQuoteId: id, unitCredits: Math.max(...contracts.map(contract => contract!.authorizedCredits)),
    estimatedCredits: total, expiresAt };
}

export async function consumeBatchQuote(tx: Prisma.TransactionClient, owner: string, body: Record<string, unknown>) {
  if (typeof body.batchQuoteId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.batchQuoteId)) throw new StudioError('整批报价编号无效');
  const row = await tx.platformSetting.findUnique({ where: { key: key(owner, body.batchQuoteId) } });
  if (!row) throw new StudioError('整批报价已过期或不可用', 409);
  const stored = JSON.parse(row.value_json);
  if (stored.owner !== owner || stored.fingerprint !== batchQuoteFingerprint(body) || Date.parse(stored.expiresAt) <= Date.now()
    || !Array.isArray(stored.contracts) || stored.contracts.length !== (body.sources as unknown[]).length || stored.total > Number(body.budget)) throw new StudioError('本批条件、报价或预算已变化', 409);
  const contracts = stored.contracts.map((contract: unknown) => parseImageBillingContract(JSON.stringify(contract)));
  for (const contract of contracts) {
    if (!contract || contract.mode !== 'actual') throw new StudioError('本批合同无效', 409);
    const ready = await imageBillingReady(contract.scope, contract.model, tx);
    if (!ready.ready || ready.intentRevision !== stored.intentRevision) throw new StudioError('实扣设置已变化，请重新报价', 409);
  }
  if ((await tx.platformSetting.deleteMany({ where: { id: row.id, value_json: row.value_json } })).count !== 1) throw new StudioError('整批报价已被使用', 409);
  return { contracts: contracts as ImageBillingContract[], total: stored.total as number, unitCredits: stored.unitCredits as number };
}
