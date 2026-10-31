import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { VideoFeishuError } from '@/lib/video/feishu-contract';
import { studioTaskHasViewableOutput, studioOutputFormatForMime } from './dimension-mismatch';
import { IMAGE_FEISHU_MAX_BYTES, type ImageFeishuPresentation } from './feishu-contract';
import { IMAGE_FEISHU_ORIGINAL_MAX_BYTES } from './feishu-original-contract';
import type { authorizedImageFeishuTask } from './feishu-notification';

type Current = Awaited<ReturnType<typeof authorizedImageFeishuTask>>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = () => new VideoFeishuError('image_original_unavailable', 409, false, true);
export function imageFeishuSourceStamp(current: Current) {
  return hash([current.task.id, current.task.asset_id, current.task.deleted_at, current.asset?.id, current.asset?.hash,
    current.asset?.original_url, current.asset?.mime_type, current.asset?.file_size, current.asset?.width, current.asset?.height]);
}
export function imageFeishuMode(format: string, size: number, width: number, height: number) {
  // TIFF/HEIC are converted by Feishu; AVIF is not accepted. Do not silently change an original.
  if (!['png', 'jpeg', 'webp', 'gif', 'bmp', 'ico'].includes(format)) return { mode: 'link' as const, reason: 'image_format_link_only' };
  if (size > IMAGE_FEISHU_MAX_BYTES || width > (format === 'gif' ? 2000 : 12000) || height > (format === 'gif' ? 2000 : 12000)) {
    return { mode: 'link' as const, reason: 'image_size_link_only' };
  }
  return { mode: 'image' as const, reason: null };
}
export async function prepareImageFeishuSource(current: Current, eventVersion: 1 | 2 | 'original' = 1) {
  const { task, asset } = current;
  if (!studioTaskHasViewableOutput(task) || !asset || !asset.hash || !/^[a-f0-9]{64}$/.test(asset.hash)
    || !Number.isSafeInteger(asset.file_size) || !asset.file_size || asset.file_size > 96 * 1024 * 1024) throw unavailable();
  const format = studioOutputFormatForMime(asset.mime_type);
  if (!format || asset.original_url !== `/uploads/assets/${asset.hash}.${format.extension}`) throw unavailable();
  const root = await realpath(path.join(process.cwd(), 'public/uploads'));
  const file = path.join(root, 'assets', `${asset.hash}.${format.extension}`);
  if (await realpath(file) !== file || !file.startsWith(root + path.sep)) throw unavailable();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== asset.file_size) throw unavailable();
    const same = (value: typeof before) => value.isFile() && value.dev === before.dev && value.ino === before.ino
      && value.size === before.size && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs;
    const bytes = await handle.readFile();
    if (!same(await handle.stat()) || !same(await lstat(file)) || createHash('sha256').update(bytes).digest('hex') !== asset.hash) throw unavailable();
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 64_000_000 }).timeout({ seconds: 45 });
    const metadata = await image.metadata();
    await image.stats(); // Decode the complete original; dimensions alone are not completion evidence.
    const decodedFormat = eventVersion === 'original' && format.mimeType === 'image/avif'
      && metadata.format === 'heif' && metadata.compression === 'av1' ? 'avif' : metadata.format;
    if (!metadata.width || !metadata.height || metadata.width !== asset.width || metadata.height !== asset.height
      || decodedFormat !== (format.mimeType === 'image/jpeg' ? 'jpeg' : format.extension)) throw unavailable();
    const policy = imageFeishuMode(decodedFormat, bytes.length, metadata.width, metadata.height);
    if (eventVersion === 'original' && bytes.length > IMAGE_FEISHU_ORIGINAL_MAX_BYTES) throw new VideoFeishuError('image_original_too_large', 409);
    let uploadBytes: Buffer = bytes;
    let uploadMimeType = format.mimeType;
    let uploadExtension = format.extension;
    let presentation: ImageFeishuPresentation | undefined;
    if (eventVersion === 2) {
      let kind: ImageFeishuPresentation['kind'] = 'original';
      let uploadWidth = metadata.width;
      let uploadHeight = metadata.height;
      if (policy.mode === 'link') {
        kind = 'preview';
        uploadBytes = await sharp(bytes, { failOn: 'warning', limitInputPixels: 64_000_000 }).timeout({ seconds: 45 })
          .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 86, alphaQuality: 100, effort: 4 })
          .toBuffer();
        const preview = await sharp(uploadBytes, { failOn: 'warning' }).metadata();
        if (!preview.width || !preview.height || preview.format !== 'webp' || uploadBytes.length > IMAGE_FEISHU_MAX_BYTES) throw unavailable();
        uploadWidth = preview.width;
        uploadHeight = preview.height;
        uploadMimeType = 'image/webp';
        uploadExtension = 'webp';
      }
      presentation = { kind, contentHash: createHash('sha256').update(uploadBytes).digest('hex'), width: uploadWidth, height: uploadHeight,
        originalWidth: metadata.width, originalHeight: metadata.height, mimeType: uploadMimeType, extension: uploadExtension };
    }
    const stamp = imageFeishuSourceStamp(current);
    return { ...(eventVersion === 'original' ? { mode: policy.mode === 'image' ? 'image' as const : 'file' as const, reason: null } : eventVersion === 2 ? { mode: 'image' as const, reason: null } : policy), assetId: asset.id, contentHash: asset.hash,
      version: hash([stamp, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]),
      file: eventVersion === 'original' || eventVersion === 2 || policy.mode === 'image' ? new Blob([Uint8Array.from(uploadBytes)], { type: uploadMimeType }) : null,
      extension: uploadExtension, size: bytes.length, width: metadata.width, height: metadata.height, mimeType: format.mimeType, ...(presentation ? { presentation } : {}),
      current: async () => { try { return await realpath(file) === file && same(await lstat(file)); } catch { return false; } } };
  } catch (error) {
    if (error instanceof VideoFeishuError) throw error;
    throw unavailable();
  } finally { await handle.close(); }
}
