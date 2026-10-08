import type { CreateVideoInput } from '@/types';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildSeedanceVideoPayload, SEEDANCE_INLINE_REQUEST_MAX_BYTES } from './jimeng';

type AuthorizedImage = { url: string; asset?: {
  original_url: string; type: string; status: string; mime_type: string; file_size: number;
} | null };
const MAX_SINGLE_IMAGE_BYTES = 30_000_000;
// Client request ID and callback URL are added later by the existing task route.
const TASK_METADATA_RESERVE_BYTES = 8192;

async function readLocalOriginal(url: string): Promise<Buffer> {
  const local = siteUploadPathFromUrl(url);
  if (!local) throw Error('原图不是已授权的本地素材，尚未提交视频生成');
  const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
  const file = await fs.realpath(path.resolve(process.cwd(), 'public', local.replace(/^\/+/, '')));
  if (!file.startsWith(`${root}${path.sep}`)) throw Error('原图路径无效，尚未提交视频生成');
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size >= MAX_SINGLE_IMAGE_BYTES) throw Error('单张原图必须小于30MB，尚未提交视频生成');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!part.bytesRead) throw Error('原图读取不完整，尚未提交视频生成');
      offset += part.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('原图读取期间发生变化，尚未提交视频生成');
    return bytes;
  } finally { await handle.close(); }
}

// Call only with records already checked by getAuthorizedReferenceImagesForUse.
// Originals and durable snapshots stay untouched; bytes exist only for this POST.
export async function seedanceLocalReferenceTransport(input: CreateVideoInput,
  authorized: AuthorizedImage[], read = readLocalOriginal): Promise<Partial<CreateVideoInput>> {
  const sources = new Map<string, NonNullable<AuthorizedImage['asset']>>();
  for (const image of authorized) {
    const asset = image.asset;
    if (!asset || asset.type !== 'image' || asset.status !== 'active') continue;
    const local = siteUploadPathFromUrl(asset.original_url);
    if (local && !local.startsWith('/uploads/thumbs/')) sources.set(local, asset);
  }
  const urls = input.generation_mode === 'first_last_frame' ? [input.first_frame_url, input.last_frame_url].filter(Boolean)
    : input.generation_mode === 'smart_multi_frame' ? input.frame_image_urls || [] : input.reference_image_urls || [];
  const inlineSources = urls.map(url => sources.get(siteUploadPathFromUrl(url!) || '')).filter(Boolean);
  if (!inlineSources.length) return {};
  const baseRequestBytes = Buffer.byteLength(JSON.stringify(buildSeedanceVideoPayload(input)));
  let predictedBytes = baseRequestBytes + TASK_METADATA_RESERVE_BYTES;
  for (const asset of inlineSources) {
    if (!asset || !Number.isSafeInteger(asset.file_size) || asset.file_size <= 0 || asset.file_size >= MAX_SINGLE_IMAGE_BYTES) {
      throw Error('单张原图必须小于30MB，尚未提交视频生成');
    }
    // Count every occurrence in the JSON body, even when the file is read once.
    predictedBytes += 4 * Math.ceil(asset.file_size / 3) + 64;
  }
  if (predictedBytes > SEEDANCE_INLINE_REQUEST_MAX_BYTES) throw Error('原图编码后的请求超过64MB，尚未提交视频生成');
  const cached = new Map<string, string>();
  const convert = async (url: string) => {
    const local = siteUploadPathFromUrl(url);
    const asset = local ? sources.get(local) : null;
    if (!asset || !local) return url;
    if (cached.has(local)) return cached.get(local)!;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime_type)) throw Error('此原图格式暂不支持直接传给视频服务');
    const bytes = await read(asset.original_url);
    if (!bytes.length || bytes.length !== asset.file_size) throw Error('原图大小与记录不一致，尚未提交视频生成；请保留原件并联系管理员');
    const value = `data:${asset.mime_type};base64,${bytes.toString('base64')}`;
    cached.set(local, value);
    return value;
  };
  const patch: Partial<CreateVideoInput> = {};
  if (input.generation_mode === 'all_in_one_reference' && input.reference_image_urls?.length) {
    const values = [];
    for (const url of input.reference_image_urls) values.push(await convert(url));
    if (cached.size) patch.reference_image_base64_data = values;
  } else if (input.generation_mode === 'first_last_frame') {
    if (input.first_frame_url) {
      const value = await convert(input.first_frame_url);
      if (value !== input.first_frame_url) patch.first_frame_base64_data = value;
    }
    if (input.last_frame_url) {
      const value = await convert(input.last_frame_url);
      if (value !== input.last_frame_url) patch.last_frame_base64_data = value;
    }
  } else if (input.generation_mode === 'smart_multi_frame' && input.frame_image_urls?.length) {
    const values = [];
    for (const url of input.frame_image_urls) values.push(await convert(url));
    if (cached.size) patch.frame_image_base64_data = values;
  }
  if (Buffer.byteLength(JSON.stringify(buildSeedanceVideoPayload({ ...input, ...patch }))) + TASK_METADATA_RESERVE_BYTES > SEEDANCE_INLINE_REQUEST_MAX_BYTES) {
    throw Error('原图编码后的请求超过64MB，尚未提交视频生成');
  }
  return patch;
}
