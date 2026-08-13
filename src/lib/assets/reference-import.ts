import path from 'path';
import type { Asset } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { addAssetToWorkspace } from '@/lib/assets/workspace';
import { sameOriginPublicUrlForSiteUpload } from '@/lib/assets/site-url';
import { uniquePreserveOrder } from '@/lib/reference-albums/permissions';

const CODEX_REFERENCE_ALBUM_NAME = 'Codex API 参考图';
const WORKSPACE_REFERENCE_ALBUM_NAME = '生成工作台参考图';

export class ReferenceImportError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'reference_import_failed',
  ) {
    super(message);
  }
}

export type ImportedReferenceImage = {
  assetId: string;
  referenceImageId: string;
  workspaceAssetId: string;
  originalUrl: string;
  fileName: string;
};

type ReferenceImportContext = {
  user: SessionUser;
  workspaceId: string;
  projectId?: string | null;
  sourceRequestId?: string | null;
  sourceLabel?: string | null;
  role?: string;
  albumName?: string;
  albumDescription?: string;
  metadataSource?: string;
  allowSharedAsset?: boolean;
};

function normalizeReferenceUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ReferenceImportError(`参考图 URL 无效: ${rawUrl}`, 400, 'invalid_reference_url');
  }

  if (parsed.protocol !== 'https:') {
    throw new ReferenceImportError(`参考图必须是公网 HTTPS URL: ${rawUrl}`, 400, 'reference_url_not_https');
  }

  const hostname = parsed.hostname.toLowerCase();
  const isPrivateHost = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '::1'
    || hostname.startsWith('10.')
    || hostname.startsWith('127.')
    || hostname.startsWith('169.254.')
    || hostname.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    || hostname.endsWith('.local');
  if (isPrivateHost) {
    throw new ReferenceImportError(`参考图不能使用本地或内网地址: ${rawUrl}`, 400, 'reference_url_not_public');
  }

  parsed.hash = '';
  return sameOriginPublicUrlForSiteUpload(parsed.toString()) || parsed.toString();
}

function inferImageMimeType(url: string) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  const mimeByExt: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  return mimeByExt[ext] || 'image/png';
}

function inferImageFileName(url: string, index: number) {
  const pathname = new URL(url).pathname;
  const baseName = path.basename(decodeURIComponent(pathname || ''));
  if (baseName && baseName.includes('.')) return baseName.slice(0, 180);
  const ext = inferImageMimeType(url).split('/')[1] || 'png';
  return `codex-reference-${index + 1}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

async function getOrCreateReferenceAlbum(
  user: SessionUser,
  albumName = CODEX_REFERENCE_ALBUM_NAME,
  albumDescription = 'Codex 接口上传或导入的生成参考图',
) {
  const existing = await prisma.referenceAlbum.findFirst({
    where: {
      owner_user_id: user.id,
      project_id: null,
      album_type: 'personal',
      name: albumName,
      status: 'active',
    },
    orderBy: { updated_at: 'desc' },
  });
  if (existing) return existing;

  return prisma.referenceAlbum.create({
    data: {
      owner_user_id: user.id,
      name: albumName,
      description: albumDescription,
      album_type: 'personal',
      visibility: 'private',
      status: 'active',
    },
  });
}

async function ensureReferenceImageRecord(
  context: ReferenceImportContext,
  asset: Pick<Asset, 'id' | 'type' | 'original_url' | 'thumbnail_url' | 'file_name'>,
) {
  if (asset.type !== 'image') {
    throw new ReferenceImportError(`素材不是图片: ${asset.id}`, 400, 'reference_asset_not_image');
  }

  const metadataSource = context.metadataSource || 'codex_api';
  const originalUrl = sameOriginPublicUrlForSiteUpload(asset.original_url) || asset.original_url;
  const thumbnailUrl = asset.thumbnail_url
    ? sameOriginPublicUrlForSiteUpload(asset.thumbnail_url) || asset.thumbnail_url
    : null;
  const album = await getOrCreateReferenceAlbum(
    context.user,
    context.albumName,
    context.albumDescription,
  );
  const existing = await prisma.referenceImage.findFirst({
    where: {
      album_id: album.id,
      asset_id: asset.id,
      status: 'active',
    },
    orderBy: { updated_at: 'desc' },
  });

  let referenceImage = existing;
  if (referenceImage) {
    referenceImage = await prisma.referenceImage.update({
      where: { id: referenceImage.id },
      data: {
        workspace_id: context.workspaceId,
        project_id: context.projectId || referenceImage.project_id,
        url: originalUrl,
        thumbnail_url: thumbnailUrl,
        metadata_json: JSON.stringify({
          source: metadataSource,
          source_request_id: context.sourceRequestId || null,
          source_label: context.sourceLabel || null,
        }),
      },
    });
  } else {
    const currentMax = await prisma.referenceImage.aggregate({
      where: { album_id: album.id },
      _max: { sort_order: true },
    });
    referenceImage = await prisma.referenceImage.create({
      data: {
        album_id: album.id,
        workspace_id: context.workspaceId,
        project_id: context.projectId || null,
        owner_user_id: context.user.id,
        asset_id: asset.id,
        url: originalUrl,
        thumbnail_url: thumbnailUrl,
        source_type: 'upload',
        source_content_id: context.sourceRequestId || null,
        sort_order: (currentMax._max.sort_order ?? -1) + 1,
        metadata_json: JSON.stringify({
          source: metadataSource,
          source_request_id: context.sourceRequestId || null,
          source_label: context.sourceLabel || null,
        }),
        status: 'active',
      },
    });
  }

  if (!album.cover_image_id) {
    await prisma.referenceAlbum.update({
      where: { id: album.id },
      data: { cover_image_id: referenceImage.id },
    });
  } else {
    await prisma.referenceAlbum.update({
      where: { id: album.id },
      data: { updated_at: new Date() },
    });
  }

  return { album, referenceImage };
}

async function ensureReferenceImageForAsset(
  context: ReferenceImportContext,
  asset: Pick<Asset, 'id' | 'type' | 'original_url' | 'thumbnail_url' | 'file_name'>,
): Promise<ImportedReferenceImage> {
  const { referenceImage } = await ensureReferenceImageRecord(context, asset);
  const workspaceAssetId = await addAssetToWorkspace(
    context.workspaceId,
    asset.id,
    context.role || 'reference_image',
    context.user.id,
    { referenceImageId: referenceImage.id, allowSharedAsset: true },
  );

  return {
    assetId: asset.id,
    referenceImageId: referenceImage.id,
    workspaceAssetId,
    originalUrl: sameOriginPublicUrlForSiteUpload(asset.original_url) || asset.original_url,
    fileName: asset.file_name,
  };
}

export async function attachAssetToCodexReferenceImage(
  context: ReferenceImportContext,
  assetId: string,
): Promise<ImportedReferenceImage> {
  return attachAssetToSiteReferenceImage({
    ...context,
    albumName: context.albumName || CODEX_REFERENCE_ALBUM_NAME,
    albumDescription: context.albumDescription || 'Codex 接口上传或导入的生成参考图',
    metadataSource: context.metadataSource || 'codex_api',
  }, assetId);
}

export async function attachAssetToSiteReferenceImage(
  context: ReferenceImportContext,
  assetId: string,
): Promise<ImportedReferenceImage> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) {
    throw new ReferenceImportError(`素材不存在: ${assetId}`, 404, 'reference_asset_not_found');
  }
  if (!context.allowSharedAsset && asset.owner_id !== context.user.id && context.user.role !== 'admin') {
    throw new ReferenceImportError(`无权使用此素材: ${assetId}`, 403, 'reference_asset_forbidden');
  }
  return ensureReferenceImageForAsset(context, asset);
}

export async function ensureWorkspaceImageAssetsHaveReferenceImages(
  context: ReferenceImportContext,
): Promise<ImportedReferenceImage[]> {
  const workspaceAssets = await prisma.workspaceAsset.findMany({
    where: {
      workspace_id: context.workspaceId,
      reference_image_id: null,
      asset: { type: 'image' },
    },
    include: { asset: true },
    orderBy: { sort_order: 'asc' },
  });

  const imported: ImportedReferenceImage[] = [];
  for (const workspaceAsset of workspaceAssets) {
    if (!context.allowSharedAsset && workspaceAsset.asset.owner_id !== context.user.id && context.user.role !== 'admin') {
      continue;
    }
    const { referenceImage } = await ensureReferenceImageRecord(
      {
        ...context,
        albumName: context.albumName || WORKSPACE_REFERENCE_ALBUM_NAME,
        albumDescription: context.albumDescription || '生成工作台自动归档的参考图',
        metadataSource: context.metadataSource || 'workspace_generation',
      },
      workspaceAsset.asset,
    );
    const updatedWorkspaceAsset = await prisma.workspaceAsset.update({
      where: { id: workspaceAsset.id },
      data: {
        reference_image_id: referenceImage.id,
        role: workspaceAsset.role || context.role || 'reference_image',
      },
    });
    imported.push({
      assetId: workspaceAsset.asset.id,
      referenceImageId: referenceImage.id,
      workspaceAssetId: updatedWorkspaceAsset.id,
      originalUrl: sameOriginPublicUrlForSiteUpload(workspaceAsset.asset.original_url) || workspaceAsset.asset.original_url,
      fileName: workspaceAsset.asset.file_name,
    });
  }

  return imported;
}

export async function importReferenceImageUrlsToSite(
  context: ReferenceImportContext & { urls: string[] },
): Promise<ImportedReferenceImage[]> {
  const urls = uniquePreserveOrder(context.urls).slice(0, 9);
  const imported: ImportedReferenceImage[] = [];

  for (let index = 0; index < urls.length; index += 1) {
    const normalizedUrl = normalizeReferenceUrl(urls[index]);
    let asset = await prisma.asset.findFirst({
      where: {
        original_url: normalizedUrl,
        type: 'image',
      },
    });

    if (!asset) {
      asset = await prisma.asset.create({
        data: {
          owner_id: context.user.id,
          type: 'image',
          original_url: normalizedUrl,
          thumbnail_url: null,
          file_name: inferImageFileName(normalizedUrl, index),
          mime_type: inferImageMimeType(normalizedUrl),
          file_size: 0,
          hash: null,
        },
      });
    }

    imported.push(await ensureReferenceImageForAsset(context, asset));
  }

  return imported;
}
