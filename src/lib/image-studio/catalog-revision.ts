import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { assertPricingImageConsumerReady } from '@/lib/pricing/runtime';

export type CatalogDomain = 'templates' | 'assets';
export const CATALOG_DIRECTORY_PROTOCOL = 'catalog-paged-v2';
export const catalogRevisionKey = (domain: CatalogDomain) => `catalog_directory_revision_v1:${domain}`;
export async function bumpCatalogRevision(tx: Pick<Prisma.TransactionClient, 'platformSetting'>, domains: CatalogDomain[]) {
  for (const domain of Array.from(new Set(domains))) {
    const key = catalogRevisionKey(domain), value_json = JSON.stringify({ version: 1, revision: randomBytes(32).toString('hex') });
    await tx.platformSetting.upsert({ where: { key }, create: { key, value_json }, update: { value_json } });
  }
}
export async function readCatalogRevision(tx: Pick<Prisma.TransactionClient, 'platformSetting'>, domain: CatalogDomain) {
  const row = await tx.platformSetting.findUnique({ where: { key: catalogRevisionKey(domain) }, select: { value_json: true } });
  if (!row) return null;
  const value = JSON.parse(row.value_json);
  if (value?.version !== 1 || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error('catalog_revision_unavailable');
  return value.revision as string;
}
export async function initializeCatalogRevisions(tx: Pick<Prisma.TransactionClient, 'platformSetting'>) {
  for (const domain of ['templates', 'assets'] as const) {
    const key = catalogRevisionKey(domain), value_json = JSON.stringify({ version: 1, revision: randomBytes(32).toString('hex') });
    await tx.platformSetting.upsert({ where: { key }, create: { key, value_json }, update: { value_json } });
  }
}
export async function catalogReaderReady(tx: Pick<Prisma.TransactionClient, 'platformSetting'>) {
  try { await assertPricingImageConsumerReady(tx); return true; } catch { return false; }
}
