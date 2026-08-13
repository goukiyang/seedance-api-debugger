/**
 * 资产存储服务
 * - 图片：原始文件 + 2:3 缩略图
 * - 视频/音频：仅原始文件
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@/lib/prisma';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';

// ============================================================================
// 目录配置
// ============================================================================

const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads');
const ASSETS_DIR = path.join(UPLOAD_DIR, 'assets');
const THUMBS_DIR = path.join(UPLOAD_DIR, 'thumbs');

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

function localUploadExists(url: string | null | undefined): boolean {
  if (!url || !localUploadUrlFromAssetUrl(url)) return true;
  return fs.existsSync(localPublicPath(url));
}

function restoreMissingLocalUploadFile(url: string | null | undefined, buffer: Buffer) {
  if (!url || localUploadExists(url) || !localUploadUrlFromAssetUrl(url)) return false;
  const filePath = localPublicPath(url);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return true;
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
  const thumbWidth = 300;
  const thumbHeight = 450; // 2:3

  const thumbBuffer = await sharp(buffer)
    .resize(thumbWidth, thumbHeight, {
      fit: 'cover',
      position: 'center',
    })
    .toFormat(mimeTypeToSharpFormat(mimeType), { quality: 85 })
    .toBuffer();

  const thumbHash = computeHash(thumbBuffer);
  const ext = mimeTypeToExt(mimeType);
  const thumbFileName = `${thumbHash}_thumb.${ext}`;
  const thumbPath = path.join(THUMBS_DIR, thumbFileName);

  fs.writeFileSync(thumbPath, thumbBuffer);

  return {
    thumbPath: `/uploads/thumbs/${thumbFileName}`,
    width: thumbWidth,
    height: thumbHeight,
  };
}

// ============================================================================
// 工具函数
// ============================================================================

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
  };
  return map[mimeType] || 'bin';
}

function mimeTypeToSharpFormat(mimeType: string): keyof sharp.FormatEnum {
  const map: Record<string, keyof sharp.FormatEnum> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  return map[mimeType] || 'jpeg';
}

function getAssetType(mimeType: string): 'image' | 'video' | 'audio' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

// ============================================================================
// 核心 API
// ============================================================================

export interface UploadResult {
  assetId: string;
  originalUrl: string;
  thumbnailUrl: string | null;
  hash: string;
  reused: boolean;
  width?: number;
  height?: number;
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

export async function uploadAsset(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  ownerId = 'default-user',
  mediaMetadata: UploadAssetMetadata | null = null
): Promise<UploadResult> {
  ensureDirs();

  const hash = computeHash(buffer);
  const ext = mimeTypeToExt(mimeType);
  const assetType = getAssetType(mimeType);
  const providedWidth = assetType === 'video' ? normalizeStoredDimension(mediaMetadata?.width) : null;
  const providedHeight = assetType === 'video' ? normalizeStoredDimension(mediaMetadata?.height) : null;

  // 同一用户重复上传同一文件时复用自己的记录，并恢复历史隐藏/删除状态。
  const existing = await prisma.asset.findFirst({
    where: { owner_id: ownerId, hash },
    orderBy: { created_at: 'desc' },
  });
  if (existing) {
    const updates: {
      original_url?: string;
      thumbnail_url?: string | null;
      width?: number | null;
      height?: number | null;
      status?: string;
    } = {};
    let thumbnailUrl = existing.thumbnail_url;
    let width = existing.width;
    let height = existing.height;

    if (existing.status !== 'active') {
      updates.status = 'active';
    }

    restoreMissingLocalUploadFile(existing.original_url, buffer);

    if (assetType === 'image' && (!existing.thumbnail_url || !localUploadExists(existing.thumbnail_url))) {
      const metadata = await sharp(buffer).metadata();
      width = metadata.width ?? null;
      height = metadata.height ?? null;
      const thumbResult = await generateThumbnail(buffer, mimeType);
      thumbnailUrl = thumbResult.thumbPath;
      updates.thumbnail_url = thumbResult.thumbPath;
      updates.width = width;
      updates.height = height;
    }
    if (assetType === 'video') {
      if (width == null && providedWidth != null) {
        width = providedWidth;
        updates.width = providedWidth;
      }
      if (height == null && providedHeight != null) {
        height = providedHeight;
        updates.height = providedHeight;
      }
    }

    if (Object.keys(updates).length > 0) {
      await prisma.asset.update({
        where: { id: existing.id },
        data: updates,
      });
    }

    return {
      assetId: existing.id,
      originalUrl: (updates.original_url as string | undefined) ?? existing.original_url,
      thumbnailUrl,
      hash: existing.hash ?? '',
      reused: true,
      width: width ?? undefined,
      height: height ?? undefined,
    };
  }

  // 别的用户已经上传过同一文件时，不重复上传文件，只给当前用户创建自己的可见记录。
  const sharedExisting = await prisma.asset.findFirst({
    where: {
      hash,
      type: assetType,
      status: { not: 'deleted' },
    },
    orderBy: { created_at: 'desc' },
  });
  if (sharedExisting) {
    const updates: {
      original_url?: string;
      thumbnail_url?: string | null;
      width?: number | null;
      height?: number | null;
      owner_id?: string;
      status?: string;
    } = {};
    let originalUrl = sharedExisting.original_url;
    let thumbnailUrl = sharedExisting.thumbnail_url;
    let width = sharedExisting.width;
    let height = sharedExisting.height;

    if (sharedExisting.owner_id === 'default-user' && ownerId !== 'default-user') {
      updates.owner_id = ownerId;
    }
    if (sharedExisting.status !== 'active') {
      updates.status = 'active';
    }

    restoreMissingLocalUploadFile(sharedExisting.original_url, buffer);

    if (assetType === 'image' && (!sharedExisting.thumbnail_url || !localUploadExists(sharedExisting.thumbnail_url))) {
      const metadata = await sharp(buffer).metadata();
      width = metadata.width ?? null;
      height = metadata.height ?? null;
      const thumbResult = await generateThumbnail(buffer, mimeType);
      thumbnailUrl = thumbResult.thumbPath;
      updates.thumbnail_url = thumbResult.thumbPath;
      updates.width = width;
      updates.height = height;
    }
    if (assetType === 'video') {
      if (width == null && providedWidth != null) {
        width = providedWidth;
        updates.width = providedWidth;
      }
      if (height == null && providedHeight != null) {
        height = providedHeight;
        updates.height = providedHeight;
      }
    }

    if (Object.keys(updates).length > 0) {
      await prisma.asset.update({
        where: { id: sharedExisting.id },
        data: updates,
      });
    }

    if (updates.owner_id === ownerId) {
      return {
        assetId: sharedExisting.id,
        originalUrl,
        thumbnailUrl,
        hash: sharedExisting.hash ?? '',
        reused: true,
        width: width ?? undefined,
        height: height ?? undefined,
      };
    }

    const asset = await prisma.asset.create({
      data: {
        id: uuidv4(),
        owner_id: ownerId,
        type: assetType,
        original_url: originalUrl,
        thumbnail_url: thumbnailUrl,
        file_name: fileName,
        mime_type: mimeType,
        width,
        height,
        file_size: buffer.length,
        hash,
        status: 'active',
      },
    });

    return {
      assetId: asset.id,
      originalUrl: asset.original_url,
      thumbnailUrl: asset.thumbnail_url,
      hash: asset.hash ?? '',
      reused: true,
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
    };
  }

  // 保存原始文件
  const storedFileName = `${hash}.${ext}`;
  const filePath = path.join(ASSETS_DIR, storedFileName);
  fs.writeFileSync(filePath, buffer);

  let thumbnailUrl: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  // 图片生成缩略图 + 读取尺寸
  if (assetType === 'image') {
    const metadata = await sharp(buffer).metadata();
    width = metadata.width ?? null;
    height = metadata.height ?? null;

    const thumbResult = await generateThumbnail(buffer, mimeType);
    thumbnailUrl = thumbResult.thumbPath;
  }
  if (assetType === 'video') {
    width = providedWidth;
    height = providedHeight;
  }

  // 写入数据库
  const asset = await prisma.asset.create({
    data: {
      id: uuidv4(),
      owner_id: ownerId,
      type: assetType,
      original_url: `/uploads/assets/${storedFileName}`,
      thumbnail_url: thumbnailUrl,
      file_name: fileName,
      mime_type: mimeType,
      width,
      height,
      file_size: buffer.length,
      hash,
    },
  });

  return {
    assetId: asset.id,
    originalUrl: asset.original_url,
    thumbnailUrl: asset.thumbnail_url,
    hash: asset.hash ?? '',
    reused: false,
    width: asset.width ?? undefined,
    height: asset.height ?? undefined,
  };
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
  const asset = await prisma.asset.findUnique({ where: { id } });
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

  await prisma.asset.delete({ where: { id } });
}
