import type { CreateVideoInput } from '@/types';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildSeedanceVideoPayload, SEEDANCE_INLINE_REQUEST_MAX_BYTES } from './jimeng';

export type AuthorizedImage = { url: string; asset?: {
  original_url: string; type: string; status: string; mime_type: string; file_size: number;
} | null };
export type PrivateInlineReferenceImage = { mimeType: 'image/png'; bytes: Buffer };
const MAX_SINGLE_IMAGE_BYTES = 30_000_000;
// Client request ID and callback URL are added later by the existing task route.
const TASK_METADATA_RESERVE_BYTES = 8192;

type LocalReferenceTransportPolicy = {
  buildPayload: (input: CreateVideoInput) => unknown;
  mimeTypes: Readonly<Record<string, string>>;
  maxRequestBytes: number;
  metadataReserveBytes?: number;
  encodedSizeDelta?: (url: string, mimeType: string, fileSize: number) => number;
  requestSizeMessage: string;
};

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

function authorizedSources(authorized: AuthorizedImage[]) {
  const sources = new Map<string, NonNullable<AuthorizedImage['asset']>>();
  for (const image of authorized) {
    const asset = image.asset;
    if (!asset || asset.type !== 'image' || asset.status !== 'active') continue;
    const local = siteUploadPathFromUrl(asset.original_url);
    if (local && !local.startsWith('/uploads/thumbs/')) sources.set(local, asset);
  }
  return sources;
}

function assertOriginalSize(asset: NonNullable<AuthorizedImage['asset']>) {
  if (!Number.isSafeInteger(asset.file_size) || asset.file_size <= 0 || asset.file_size >= MAX_SINGLE_IMAGE_BYTES) {
    throw Error('单张原图必须小于30MB，尚未提交视频生成');
  }
}

async function readCheckedOriginal(asset: NonNullable<AuthorizedImage['asset']>, read: (url: string) => Promise<Buffer>) {
  assertOriginalSize(asset);
  const bytes = await read(asset.original_url);
  if (!bytes.length || bytes.length !== asset.file_size) throw Error('原图大小与记录不一致，尚未提交视频生成；请保留原件并联系管理员');
  return bytes;
}

export async function readAuthorizedLocalReferenceOriginal(url: string, authorized: AuthorizedImage[], read = readLocalOriginal) {
  const local = siteUploadPathFromUrl(url);
  const asset = local ? authorizedSources(authorized).get(local) : null;
  if (!asset) throw Error('本地原图未获本次使用授权，尚未提交视频生成');
  return readCheckedOriginal(asset, read);
}

// Call only with records already checked by getAuthorizedReferenceImagesForUse,
// or a server-created derivative bound to one of those exact authorized sources.
// Originals and durable snapshots stay untouched; bytes exist only for this POST.
export async function authorizedLocalReferenceTransport(input: CreateVideoInput,
  authorized: AuthorizedImage[], policy: LocalReferenceTransportPolicy, read = readLocalOriginal,
  privateReferences: PrivateInlineReferenceImage[] = []): Promise<Partial<CreateVideoInput>> {
  const sources = authorizedSources(authorized);
  const urls = input.generation_mode === 'first_last_frame' ? [input.first_frame_url, input.last_frame_url].filter(Boolean)
    : input.generation_mode === 'smart_multi_frame' ? input.frame_image_urls || [] : input.reference_image_urls || [];
  const inlineSources = urls.flatMap(url => {
    const asset = sources.get(siteUploadPathFromUrl(url!) || '');
    return asset ? [{ url: url!, asset }] : [];
  });
  if (!inlineSources.length && !privateReferences.length) return {};
  const baseRequestBytes = Buffer.byteLength(JSON.stringify(policy.buildPayload(input)));
  let predictedBytes = baseRequestBytes + (policy.metadataReserveBytes || 0);
  for (const { url, asset } of inlineSources) {
    assertOriginalSize(asset);
    // Count every occurrence in the JSON body, even when the file is read once.
    predictedBytes += policy.encodedSizeDelta
      ? policy.encodedSizeDelta(url, policy.mimeTypes[asset.mime_type] || asset.mime_type, asset.file_size)
      : 4 * Math.ceil(asset.file_size / 3) + 64;
  }
  for (const image of privateReferences) {
    if (image.mimeType !== 'image/png' || !Buffer.isBuffer(image.bytes) || image.bytes.length < 24
      || image.bytes.length >= MAX_SINGLE_IMAGE_BYTES || !image.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw Error('系统参考图无法安全读取，尚未提交视频生成');
    }
    predictedBytes += 4 * Math.ceil(image.bytes.length / 3) + 64;
  }
  if (predictedBytes > policy.maxRequestBytes) throw Error(policy.requestSizeMessage);
  const cached = new Map<string, string>();
  const convert = async (url: string) => {
    const local = siteUploadPathFromUrl(url);
    const asset = local ? sources.get(local) : null;
    if (!asset || !local) return url;
    if (cached.has(local)) return cached.get(local)!;
    const mimeType = policy.mimeTypes[asset.mime_type];
    if (!mimeType) throw Error('此原图格式暂不支持直接传给视频服务');
    const bytes = await readCheckedOriginal(asset, read);
    const value = `data:${mimeType};base64,${bytes.toString('base64')}`;
    cached.set(local, value);
    return value;
  };
  const patch: Partial<CreateVideoInput> = {};
  if (input.generation_mode === 'all_in_one_reference' && input.reference_image_urls?.length) {
    const values = [];
    for (const url of input.reference_image_urls) values.push(await convert(url));
    for (const image of privateReferences) values.push(`data:${image.mimeType};base64,${image.bytes.toString('base64')}`);
    if (cached.size || privateReferences.length) patch.reference_image_base64_data = values;
  } else if (input.generation_mode === 'all_in_one_reference' && privateReferences.length) {
    patch.reference_image_base64_data = privateReferences.map(image => `data:${image.mimeType};base64,${image.bytes.toString('base64')}`);
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
  if (Buffer.byteLength(JSON.stringify(policy.buildPayload({ ...input, ...patch }))) + (policy.metadataReserveBytes || 0) > policy.maxRequestBytes) {
    throw Error(policy.requestSizeMessage);
  }
  return patch;
}

export async function seedanceLocalReferenceTransport(input: CreateVideoInput,
  authorized: AuthorizedImage[], read = readLocalOriginal,
  privateReferences: PrivateInlineReferenceImage[] = []): Promise<Partial<CreateVideoInput>> {
  return authorizedLocalReferenceTransport(input, authorized, {
    buildPayload: buildSeedanceVideoPayload,
    mimeTypes: { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/webp': 'image/webp' },
    maxRequestBytes: SEEDANCE_INLINE_REQUEST_MAX_BYTES,
    metadataReserveBytes: TASK_METADATA_RESERVE_BYTES,
    requestSizeMessage: '原图编码后的请求超过64MB，尚未提交视频生成',
  }, read, privateReferences);
}
