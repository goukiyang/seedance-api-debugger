/**
 * 资产存储服务
 * - 图片：原始文件 + 2:3 缩略图
 * - 视频：原始文件 + 首帧封面
 * - 音频：仅原始文件
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '@/lib/prisma';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { generateAssetVideoThumbnail } from '@/lib/assets/video-thumbnail';
import { assertStudioCoverAssetNotReferenced } from '@/lib/image-studio/protected-assets';
import { findVerifiedOwnUpload, privateUploadDirectory, publishVerifiedFile, registerVerifiedUpload, releaseVerifiedUpload, stageVerifiedUpload, uploadFileVersion, uploadIdentity, VerifiedUploadError, type UploadReceipt, type VerifiedUpload } from './verified-upload';
import { enqueueUploadSimilarity, uploadSimilarityStatus, type UploadSimilarityStatus } from './upload-similarity';

// ============================================================================
// 目录配置
// ============================================================================

const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads');
const ASSETS_DIR = path.join(UPLOAD_DIR, 'assets');
const THUMBS_DIR = path.join(UPLOAD_DIR, 'thumbs');
const execFileAsync = promisify(execFile);

// 确保目录存在
function ensureDirs() {
  [ASSETS_DIR, THUMBS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function localUploadUrlFromAssetUrl(url: string | null | undefined): string | null {
  return siteUploadPathFromUrl(url);
}

function localPublicPath(url: string): string {
  const localUrl = localUploadUrlFromAssetUrl(url);
  if (!localUrl) throw new Error(`Not a local upload URL: ${url}`);
  const publicRoot = path.resolve(process.cwd(), 'public');
  const resolvedPath = path.resolve(publicRoot, localUrl.replace(/^\/+/, ''));
  if (!resolvedPath.startsWith(`${publicRoot}${path.sep}`)) {
    throw new Error(`Unsafe local upload URL: ${url}`);
  }
  return resolvedPath;
}


// ============================================================================
// Hash 计算（去重）
// ============================================================================

function computeHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ============================================================================
// 缩略图生成（2:3 比例）
// ============================================================================

async function generateThumbnail(
  buffer: Buffer,
  mimeType: string
): Promise<{ thumbPath: string; width: number; height: number }> {
  const thumbWidth = 640;
  const thumbHeight = 640;

  const { data: thumbBuffer, info } = await sharp(buffer, { animated: false, limitInputPixels: 40_000_000 }).timeout({ seconds: 45 }).rotate()
    .resize(thumbWidth, thumbHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 78 })
    .toBuffer({ resolveWithObject: true });

  const thumbHash = computeHash(thumbBuffer);
  const ext = 'webp';
  const thumbFileName = `${thumbHash}_thumb.${ext}`;

  const proof = await stageVerifiedUpload((async function* () { yield thumbBuffer; })(), 'image/webp', thumbBuffer.length);
  try { await publishVerifiedFile(proof, THUMBS_DIR, thumbFileName); } finally { await releaseVerifiedUpload(proof); }

  return {
    thumbPath: `/uploads/thumbs/${thumbFileName}`,
    width: info.width,
    height: info.height,
  };
}
export async function prepareVerifiedUploadThumbnail(proof: VerifiedUpload) {
  if (proof.mimeType === 'image/bmp') {
    if (await uploadFileVersion(proof.file) !== proof.version) throw new VerifiedUploadError('UPLOAD_SOURCE_CHANGED', 'BMP 原件已变化');
    const directory = await fs.promises.mkdtemp(path.join(await privateUploadDirectory(), 'bmp-thumbnail-'));
    const temporary = path.join(directory, 'thumbnail.png');
    let preview: VerifiedUpload | null = null;
    try {
      // Decode the verified original into a small private derivative only. The
      // BMP bytes/hash are never converted, overwritten, or used as a preview.
      await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
        '-threads', '2', '-f', 'bmp_pipe', '-i', proof.file, '-map', '0:v:0', '-frames:v', '1',
        '-vf', "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease",
        '-threads', '2', '-c:v', 'png', '-fs', String(2 * 1024 * 1024), '-f', 'image2', temporary], { timeout: 45000, maxBuffer: 65536 });
      await fs.promises.chmod(temporary, 0o600);
      const stat = await fs.promises.lstat(temporary);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) throw new VerifiedUploadError('UPLOAD_PREVIEW_INVALID', 'BMP 缩略图无法安全验证');
      const bytes = await fs.promises.readFile(temporary);
      preview = await stageVerifiedUpload((async function* () { yield bytes; })(), 'image/png', bytes.length);
      if (!preview.width || !preview.height || preview.width > 640 || preview.height > 640
        || await uploadFileVersion(proof.file) !== proof.version) throw new VerifiedUploadError('UPLOAD_PREVIEW_INVALID', 'BMP 原件或缩略图已变化');
      return (await generateThumbnail(bytes, 'image/png')).thumbPath;
    } finally {
      await releaseVerifiedUpload(preview);
      await fs.promises.unlink(temporary).catch(() => {});
      await fs.promises.rmdir(directory).catch(() => {});
    }
  }
  if (proof.type === 'image') return (await generateThumbnail(await fs.promises.readFile(proof.file), proof.mimeType)).thumbPath;
  if (proof.type === 'video') return generateVideoThumbnailFromFile(proof.file, proof.hash);
  return null;
}

// ============================================================================
// 工具函数
// ============================================================================


// ============================================================================
// 核心 API
// ============================================================================

export interface UploadResult {
  fileName: string;
  fileSize: number;
  mimeType: string;
  assetId: string;
  originalUrl: string;
  thumbnailUrl: string | null;
  hash: string;
  reused: boolean;
  width?: number;
  height?: number;
  upload?: UploadReceipt;
  similarity?: UploadSimilarityStatus;
}

export type UploadAssetMetadata = {
  width?: number | null;
  height?: number | null;
};

function normalizeStoredDimension(value: number | null | undefined) {
  if (!Number.isFinite(value) || value == null) return null;
  const next = Math.floor(value);
  return next > 0 && next < 100000 ? next : null;
}

async function generateVideoThumbnailFromFile(sourcePath: string, outputName: string) {
  const result = await generateAssetVideoThumbnail({
    sourcePath,
    outputDir: THUMBS_DIR,
    outputName,
  });
  if (!result.success || !result.thumbnailPath) {
    console.warn('[Assets] Video thumbnail skipped:', {
      sourcePath,
      error: result.error,
    });
    return null;
  }
  return `/uploads/thumbs/${path.basename(result.thumbnailPath)}`;
}


export async function uploadAsset(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  ownerId = 'default-user',
  mediaMetadata: UploadAssetMetadata | null = null,
  requestId?: string,
  receiptFingerprint?: string,
): Promise<UploadResult> {
  await uploadIdentity(ownerId);
  await privateUploadDirectory();
  ensureDirs();
  const proof = await stageVerifiedUpload((async function* () { yield buffer; })(), mimeType, buffer.length);
  let reusedProof: VerifiedUpload | undefined;
  try {
    const existing = await findVerifiedOwnUpload(ownerId, proof.hash, proof.mimeType, proof.bytes);
    reusedProof = existing?.proof;
    let originalUrl = existing?.asset.original_url || '', thumbnailUrl = existing?.asset.thumbnail_url || null;
    if (!existing) {
      const filename = `${proof.hash}.${proof.extension}`;
      const original = await publishVerifiedFile(proof, ASSETS_DIR, filename);
      originalUrl = `/uploads/assets/${filename}`;
      thumbnailUrl = proof.type === 'image' ? await prepareVerifiedUploadThumbnail(proof)
        : proof.type === 'video' ? await generateVideoThumbnailFromFile(original, proof.hash) : null;
    }
    const registered = await registerVerifiedUpload({ ownerId, proof, fileName, originalUrl, thumbnailUrl, requestId, fingerprint: receiptFingerprint,
      width: normalizeStoredDimension(mediaMetadata?.width), height: normalizeStoredDimension(mediaMetadata?.height) });
    const asset = registered.asset;
    // Queue/index failure never turns an already committed upload into a failure.
    if (!registered.reused && proof.type === 'image') void enqueueUploadSimilarity(asset).catch(() => {});
    const similarity = await uploadSimilarityStatus(ownerId, asset.id).catch(() => ({ state: 'unavailable' as const, coverage: 'new_uploads_only' as const }));
    const source = siteUploadPathFromUrl(asset.original_url);
    const sourceVersion = existing && existing.asset.id === asset.id ? existing.proof.sourceVersion || existing.proof.version
      : source ? await uploadFileVersion(path.join(process.cwd(), 'public', source.replace(/^\/+/, ''))) : '';
    if (!sourceVersion) throw new Error('原文件身份暂无法确认');
    return { assetId: asset.id, originalUrl: asset.original_url, thumbnailUrl: asset.thumbnail_url, hash: proof.hash,
      fileName: asset.file_name, fileSize: asset.file_size, mimeType: asset.mime_type,
      reused: registered.reused, width: asset.width ?? undefined, height: asset.height ?? undefined,
      upload: { requestId: requestId || proof.hash, verified: true, assetDisposition: registered.reused ? 'reused' : 'new', sourceVersion }, similarity };
  } finally { await releaseVerifiedUpload(reusedProof); await releaseVerifiedUpload(proof); }
}

export async function getAssetById(id: string) {
  return prisma.asset.findUnique({
    where: { id },
    include: {
      workspace_assets: {
        include: { workspace: true },
        orderBy: { sort_order: 'asc' },
      },
    },
  });
}

export async function deleteAsset(id: string) {
  const asset = await prisma.$transaction(async tx => {
    const current = await tx.asset.findUnique({ where: { id } });
    if (!current) return null;
    await assertStudioCoverAssetNotReferenced(id, tx);
    // Serialize removal against cover reservation/publication before removing bytes.
    await tx.asset.delete({ where: { id } });
    return current;
  });
  if (!asset) return;

  // 删除文件
  const originalPath = localUploadUrlFromAssetUrl(asset.original_url)
    ? localPublicPath(asset.original_url)
    : null;
  if (originalPath && fs.existsSync(originalPath)) {
    fs.unlinkSync(originalPath);
  }
  if (asset.thumbnail_url && localUploadUrlFromAssetUrl(asset.thumbnail_url)) {
    const thumbPath = localPublicPath(asset.thumbnail_url);
    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
    }
  }

}
