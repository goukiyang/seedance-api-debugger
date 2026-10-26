import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import type { ApiAsset, Asset } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveSitePublicBaseUrl } from '@/lib/assets/site-url';
import { uploadFileVersion } from '@/lib/assets/verified-upload';
import { PROVIDER_REFERENCE_IMAGE_MAX_PIXELS } from '@/lib/provider/reference-image-safety';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { CustomerApiError, digest, type ApiContext, type ApiTx } from './auth';
import { privateMediaPath } from './private-media';
import type { ApiVideoInput } from './contracts';

export type ApiInputAssets = { records: Array<{ public: ApiAsset; source: Asset }>; versions: Array<{ id: string; version: string }> };
export async function resolveApiInputAssets(tx: ApiTx | typeof prisma, context: ApiContext, input: ApiVideoInput): Promise<ApiInputAssets> {
  const groups = [
    { ids: [...input.image_assets, ...input.frame_assets, ...[input.first_frame_asset, input.last_frame_asset].filter((v): v is string => Boolean(v))], type: 'image' },
    { ids: input.video_assets, type: 'video' }, { ids: input.audio_assets, type: 'audio' },
  ];
  const records: ApiInputAssets['records'] = [];
  for (const group of groups) for (const id of group.ids) {
    const row = await tx.apiAsset.findFirst({ where: { id, customer_id: context.customer.id, active: true } });
    const source = row && await tx.asset.findUnique({ where: { id: row.asset_id } });
    if (!row || !source || source.owner_id !== context.user.id || source.status !== 'active' || source.type !== group.type
      || source.hash !== row.sha256 || BigInt(source.file_size) !== row.size_bytes || source.mime_type !== row.mime_type
      || !await canReadStudioAsset(context.user, source, tx)) throw new CustomerApiError('ASSET_NOT_FOUND', '素材不存在或当前不可使用。', 404);
    const file = await privateMediaPath(row.private_path, digest(context.user.id));
    if (!file || await uploadFileVersion(file) !== row.source_version || BigInt((await fs.stat(file)).size) !== row.size_bytes) throw new CustomerApiError('ASSET_UNAVAILABLE', '素材原件暂不可用。', 409);
    if (group.type === 'image' && (!source.width || !source.height || source.width * source.height > PROVIDER_REFERENCE_IMAGE_MAX_PIXELS)) throw new CustomerApiError('IMAGE_DIMENSIONS', '参考图尺寸超出生成线路上限，请上传较小的原件。', 400);
    records.push({ public: row, source });
  }
  return { records, versions: records.map(r => ({ id: r.public.id, version: r.public.source_version })) };
}

function signingSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32 || secret === 'dev-secret-change-in-production') throw new CustomerApiError('MEDIA_CONFIGURATION', '私有媒体签名服务尚未配置。', 503);
  return secret;
}
function signature(id: string, version: string, expires: number) {
  return createHmac('sha256', signingSecret()).update(`customer-api-media:v1:${id}:${version}:${expires}`).digest('hex');
}
function providerUrl(row: ApiAsset) {
  const origin = resolveSitePublicBaseUrl();
  if (!origin || !origin.startsWith('https://')) throw new CustomerApiError('MEDIA_CONFIGURATION', '生成服务需要已配置的 HTTPS 站点地址。', 503);
  const expires = Math.floor(Date.now() / 1000) + 3600;
  return `${origin}/api/internal/customer-media/${row.id}?expires=${expires}&signature=${signature(row.id, row.source_version, expires)}`;
}

export async function materializeApiInput(context: ApiContext, input: ApiVideoInput, assets: ApiInputAssets) {
  const urls = new Map(assets.records.map(r => [r.public.id, providerUrl(r.public)]));
  const url = (id: string) => urls.get(id)!;
  return { body: { prompt: input.prompt, duration: input.duration, resolution: input.resolution, ratio: input.ratio,
    generation_mode: input.generation_mode, seed: input.seed, generate_audio: input.generate_audio, watermark: input.watermark,
    reference_image_urls: input.image_assets.map(url), reference_video_urls: input.video_assets.map(url), reference_audio_urls: input.audio_assets.map(url),
    frame_image_urls: input.frame_assets.map(url), first_frame_url: input.first_frame_asset ? url(input.first_frame_asset) : undefined,
    last_frame_url: input.last_frame_asset ? url(input.last_frame_asset) : undefined },
    images: assets.records.filter(r => r.source.type === 'image').map((r, i) => ({ name: `图片${i + 1}`, originalUrl: url(r.public.id), sourceType: 'upload' as const, order: i, width: r.source.width, height: r.source.height })) };
}

export async function resolveProviderMedia(request: Request, id: string) {
  const url = new URL(request.url), raw = url.searchParams.get('signature') || '', expires = Number(url.searchParams.get('expires'));
  if (!/^[a-f0-9]{64}$/.test(raw) || !Number.isSafeInteger(expires) || expires < Date.now() / 1000 || expires > Date.now() / 1000 + 3600) throw new CustomerApiError('NOT_FOUND', '资源不存在。', 404);
  const row = await prisma.apiAsset.findUnique({ where: { id }, include: { customer: { include: { user: true } } } });
  if (!row || !row.active || !row.customer.read_enabled || row.customer.user.status !== 'active'
    || row.customer.user.account_type !== 'external' || row.customer.user.role !== 'user') throw new CustomerApiError('NOT_FOUND', '资源不存在。', 404);
  const expected = signature(id, row.source_version, expires);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(raw))) throw new CustomerApiError('NOT_FOUND', '资源不存在。', 404);
  const source = await prisma.asset.findUnique({ where: { id: row.asset_id } });
  if (!source || source.owner_id !== row.customer.user_id || source.status !== 'active' || source.hash !== row.sha256
    || !await canReadStudioAsset(row.customer.user, source)) throw new CustomerApiError('NOT_FOUND', '资源不存在。', 404);
  const file = await privateMediaPath(row.private_path, digest(row.customer.user_id));
  if (!file || await uploadFileVersion(file) !== row.source_version) throw new CustomerApiError('NOT_FOUND', '资源不存在。', 404);
  return { file, bytes: Number(row.size_bytes), mime: row.mime_type };
}
