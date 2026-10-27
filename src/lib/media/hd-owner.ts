import { siteUploadBaseUrls, siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { hdReadRepository } from './hd-readonly-db';

export type HdOwner = { kind: 'asset' | 'reference'; id: string; ownerId: string };
export type HdOwnerEvidence = HdOwner & { checkedAt: string; sourceVersion: string };
export type HdLegacyOwner = { kind: 'legacy'; checkedAt: string };
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && !/[\x00-\x1f]/.test(value);
export function validHdOwnerEvidence(value: HdOwnerEvidence, version: string) {
  return Boolean(value && ['asset', 'reference'].includes(value.kind) && validId(value.id) && validId(value.ownerId)
    && value.sourceVersion === version && Number.isFinite(Date.parse(value.checkedAt)));
}
export function hdSourceUrlCandidates(source: string) {
  const local = siteUploadPathFromUrl(source);
  if (!local) return [];
  // Exact indexed keys only. No suffix search, directory walk, or alias probing.
  return [...new Set([source, local, ...siteUploadBaseUrls().map(base => new URL(local, base).href)])];
}
const sameSource = (source: string, candidate: string) => Boolean(siteUploadPathFromUrl(source)
  && siteUploadPathFromUrl(source) === siteUploadPathFromUrl(candidate));
export async function validateHdOwner(source: string, sourceVersion: string, owner: HdOwner): Promise<HdOwnerEvidence> {
  if (!owner || !['asset', 'reference'].includes(owner.kind) || !validId(owner.id) || !validId(owner.ownerId)) throw new Error('hd_owner_invalid');
  let matches = false;
  if (owner.kind === 'asset') {
    const row = await hdReadRepository.assetById(owner.id);
    matches = Boolean(row && row.owner_id === owner.ownerId && row.status === 'active' && row.type === 'image' && sameSource(source, row.original_url));
  } else {
    const row = await hdReadRepository.referenceById(owner.id);
    matches = Boolean(row && row.owner_user_id === owner.ownerId && row.status === 'active' && row.album.status === 'active' && sameSource(source, row.url));
  }
  if (!matches) throw new Error('hd_owner_source_mismatch');
  return { ...owner, sourceVersion, checkedAt: new Date().toISOString() };
}
export async function lookupLegacyHdOwner(source: string, sourceVersion: string): Promise<HdOwnerEvidence | HdLegacyOwner> {
  const checkedAt = new Date().toISOString(), urls = hdSourceUrlCandidates(source);
  if (!urls.length) return { kind: 'legacy', checkedAt };
  // Keep the URL as the only SQL predicate: SQLite must not choose its much
  // broader status index. Validate the bounded result, without filtering away
  // evidence that another matching row (possibly a third row) is ambiguous.
  const assets = await hdReadRepository.assetsAtUrls(urls);
  if (assets.length === 1 && assets[0].status === 'active' && assets[0].type === 'image') {
    return { kind: 'asset', id: assets[0].id, ownerId: assets[0].owner_id, sourceVersion, checkedAt };
  }
  // Multiple exact matches are ambiguous, not permission to guess an owner.
  if (assets.length) return { kind: 'legacy', checkedAt };
  const references = await hdReadRepository.referencesAtUrls(urls);
  return references.length === 1 && references[0].status === 'active' && references[0].asset_id === null && references[0].album.status === 'active'
    ? { kind: 'reference', id: references[0].id, ownerId: references[0].owner_user_id, sourceVersion, checkedAt }
    : { kind: 'legacy', checkedAt };
}
export async function hdPreserveText(source: string) {
  const assets = await hdReadRepository.assetsAtUrls(hdSourceUrlCandidates(source));
  return assets.length === 2 || assets.some(asset => {
    if (asset.status !== 'active' || asset.type !== 'image') return false;
    try { return JSON.parse(asset.metadata_json || '{}').preserveText === true; } catch { return false; }
  });
}
