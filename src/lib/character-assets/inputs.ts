import { CharacterAssetError } from './errors';
import type { ReferenceImageInput } from './types';

export function normalizeArkAssetId(value: unknown): string {
  if (typeof value !== 'string') throw new CharacterAssetError('请填写角色 Asset ID', 400, 'CHARACTER_ASSET_INVALID_ID');
  const trimmed = value.trim();
  const id = trimmed.startsWith('asset://') ? trimmed.slice('asset://'.length) : trimmed;
  if (id.length > 256 || !/^asset-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new CharacterAssetError('Asset ID 需为 asset-… 或 asset://asset-…，不能填写组 ID、链接或图片数据', 400, 'CHARACTER_ASSET_INVALID_ID');
  }
  return id;
}

/** Omitted means legacy input. Supplied malformed lists never fall back. */
export function parseReferenceImageInputs(value: unknown): ReferenceImageInput[] | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new CharacterAssetError('图片参考清单格式无效，请重新选择', 400, 'CHARACTER_ASSET_INVALID_INPUTS');
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set<string>();
  return value.map((item): ReferenceImageInput => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid();
    const source = item as Record<string, unknown>;
    let result: ReferenceImageInput;
    let key: string;
    if (source.kind === 'site_image') {
      if (Object.keys(source).sort().join(',') !== 'kind,referenceImageId'
        || typeof source.referenceImageId !== 'string' || !source.referenceImageId.trim()
        || source.referenceImageId.length > 256) throw invalid();
      result = { kind: 'site_image', referenceImageId: source.referenceImageId.trim() };
      key = `site_image:${result.referenceImageId}`;
    } else if (source.kind === 'ark_asset') {
      if (Object.keys(source).sort().join(',') !== 'characterAssetId,kind,revision'
        || typeof source.characterAssetId !== 'string' || !source.characterAssetId.trim()
        || source.characterAssetId.length > 256 || !Number.isSafeInteger(source.revision)
        || Number(source.revision) < 1) throw invalid();
      result = { kind: 'ark_asset', characterAssetId: source.characterAssetId.trim(), revision: Number(source.revision) };
      key = `ark_asset:${result.characterAssetId}`;
    } else throw invalid();
    if (seen.has(key)) throw new CharacterAssetError('同一张图片或角色不能重复加入', 400, 'CHARACTER_ASSET_DUPLICATE_INPUT');
    seen.add(key);
    return result;
  });
}
