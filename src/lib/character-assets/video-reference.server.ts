import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { parseReferenceImageInputs } from './inputs';
import { resolveCharacterAssetReferences } from './service';
import type { ReferenceImageInput } from './types';
import { CHARACTER_ASSET_WRITES_ENABLED } from './build-mode';
import { seedanceReferenceMediaCapabilities } from '@/lib/provider/reference-media-policy';

export type FrozenCharacterAssetReference = {
  characterAssetId: string; revision: number; name: string; assetId: string; uri: string; position: number;
};

/** The optional ordered contract replaces only image ordering. Legacy callers retain their original path. */
export function videoReferenceImageInputs(body: Record<string, unknown>): ReferenceImageInput[] | undefined {
  let inputs: ReferenceImageInput[] | undefined;
  try { inputs = parseReferenceImageInputs(body.reference_image_inputs); }
  catch (error) { throw new AuthError(error instanceof Error ? error.message : '图片引用无效', 400); }
  if (inputs === undefined) {
    if (['reference_image_urls', 'first_frame_url', 'last_frame_url', 'frame_image_urls'].some(key =>
      JSON.stringify(body[key] ?? '').includes('asset://'))) throw new AuthError('私域角色请从角色资产目录选择，不能作为普通图片链接提交', 400);
    return undefined;
  }
  const siteIds = inputs.filter((item): item is Extract<ReferenceImageInput, { kind: 'site_image' }> => item.kind === 'site_image')
    .map(item => item.referenceImageId);
  const legacyIds = body.reference_image_ids ?? body.referenceImageIds;
  if (legacyIds !== undefined && (!Array.isArray(legacyIds) || legacyIds.length !== siteIds.length
    || legacyIds.some((id, index) => id !== siteIds[index]))) throw new AuthError('图片引用列表与原图片列表不一致，输入已保留', 400);
  if (Array.isArray(body.reference_image_urls) && body.reference_image_urls.length
    || Array.isArray(body.referenceImageUrls) && body.referenceImageUrls.length
    || body.canvas_references !== undefined || body.promptMentions != null) {
    throw new AuthError('有序图片引用不能与另一套图片链接或画布绑定混用', 400);
  }
  if (inputs.some(item => item.kind === 'ark_asset')) {
    if (body.provider !== 'volcengine_ip' && body.entry !== 'ip') throw new AuthError('私域角色仅支持 IP 线路，请切换 IP 线路并使用', 400);
    if (body.generation_mode !== undefined && body.generation_mode !== 'all_in_one_reference') {
      throw new AuthError('私域角色仅支持全能参考，请切回全能参考或从本次移除角色', 400);
    }
    if (body.first_frame_url || body.last_frame_url || Array.isArray(body.frame_image_urls) && body.frame_image_urls.length) {
      throw new AuthError('私域角色不能与首尾帧或多帧模式混用，当前输入已保留', 400);
    }
  }
  if (typeof body.model === 'string' && inputs.length > seedanceReferenceMediaCapabilities(body.model).imageLimit) {
    throw new AuthError(`普通图片与角色合计最多 ${seedanceReferenceMediaCapabilities(body.model).imageLimit} 张`, 400);
  }
  return inputs;
}

export async function resolveVideoCharacterReferences(user: SessionUser, body: Record<string, unknown>, db?: Prisma.TransactionClient) {
  const inputs = videoReferenceImageInputs(body);
  if (inputs === undefined) return undefined;
  if (!CHARACTER_ASSET_WRITES_ENABLED && inputs.some(input => input.kind === 'ark_asset')) throw new AuthError('角色资产写入暂未开放，原目录、历史任务与当前输入保留', 503);
  try { return await resolveCharacterAssetReferences(user.id, inputs, db); }
  catch (error) {
    if (error instanceof AuthError) throw error;
    const failure = error as { status?: number; message?: string };
    if (failure.status && failure.status < 500) throw new AuthError(failure.message || '角色引用已变化，请更新或移除', failure.status);
    throw error;
  }
}

/** No asset URI enters ordinary image downloads, probes, or image-file persistence. */
export function orderedVideoImageUrls(inputs: ReferenceImageInput[], siteUrls: string[], references: FrozenCharacterAssetReference[]) {
  const expected = inputs.filter(item => item.kind === 'site_image').length;
  if (siteUrls.length !== expected) throw new AuthError('本次普通图片未完整准备，原输入已保留', 400);
  let siteIndex = 0;
  return inputs.map((item, index) => {
    if (item.kind === 'site_image') return siteUrls[siteIndex++];
    const frozen = references.find(reference => reference.characterAssetId === item.characterAssetId && reference.position === index + 1);
    if (!frozen || frozen.revision !== item.revision) throw new AuthError('角色版本与本次图片顺序不一致', 409);
    return frozen.uri;
  });
}

export function validateOrderedImagePrompt(prompt: string, count: number) {
  const missing = Array.from(prompt.matchAll(/@?(?:图片|图)(\d+)(?!\d)/g)).map(match => Number(match[1]))
    .filter(number => number < 1 || number > count);
  if (missing.length) throw new AuthError(`提示词引用的图片编号不存在：${Array.from(new Set(missing)).join('、')}，请修正引用；原文字已保留`, 400);
}
