import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import type { AssetType } from '@/types';
import { sameOriginPublicUrlForSiteUpload } from '@/lib/assets/site-url';

export const dynamic = 'force-dynamic';

type HistoryAssetType = AssetType | 'all';

function clampPage(value: string | null) {
  const page = Number(value || '1');
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function clampLimit(value: string | null) {
  const limit = Number(value || '40');
  if (!Number.isFinite(limit) || limit <= 0) return 40;
  return Math.min(80, Math.max(12, Math.floor(limit)));
}

function parseHistoryAssetType(value: string | null): HistoryAssetType {
  if (value === 'image' || value === 'video' || value === 'audio' || value === 'all') return value;
  return 'image';
}

function normalizeAssetType(value: string): AssetType {
  if (value === 'video' || value === 'audio') return value;
  return 'image';
}

function publicAssetUrl(url: string | null) {
  return url ? (sameOriginPublicUrlForSiteUpload(url) || url) : null;
}

function serializeAsset(asset: {
  id: string;
  type: string;
  original_url: string;
  thumbnail_url: string | null;
  file_name: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  file_size: number;
  created_at: Date;
}) {
  const originalUrl = publicAssetUrl(asset.original_url) || asset.original_url;
  const thumbnailUrl = publicAssetUrl(asset.thumbnail_url) || originalUrl;
  return {
    id: asset.id,
    type: normalizeAssetType(asset.type),
    originalUrl,
    thumbnailUrl,
    fileName: asset.file_name,
    mimeType: asset.mime_type,
    width: asset.width,
    height: asset.height,
    fileSize: asset.file_size,
    createdAt: asset.created_at,
  };
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const page = clampPage(request.nextUrl.searchParams.get('page'));
    const limit = clampLimit(request.nextUrl.searchParams.get('limit'));
    const type = parseHistoryAssetType(request.nextUrl.searchParams.get('type'));
    const skip = (page - 1) * limit;

    const where = {
      owner_id: user.id,
      status: 'active',
      ...(type === 'all' ? {} : { type }),
    };

    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          type: true,
          original_url: true,
          thumbnail_url: true,
          file_name: true,
          mime_type: true,
          width: true,
          height: true,
          file_size: true,
          created_at: true,
        },
      }),
      prisma.asset.count({ where }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return NextResponse.json({
      assets: assets.map(serializeAsset),
      pagination: {
        page,
        limit,
        total,
        total_pages: totalPages,
        has_more: page < totalPages,
      },
    });
  } catch (error) {
    console.error('[AssetHistory] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
