import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import type { AssetType } from '@/types';
import { sameOriginPublicUrlForSiteUpload } from '@/lib/assets/site-url';
import { Prisma } from '@prisma/client';
import { studioHiddenAssetUrls } from '@/lib/image-studio/protected-assets';

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
    const hiddenUrls = await studioHiddenAssetUrls(user);
    const visibleWhere = hiddenUrls.length ? { original_url: { notIn: hiddenUrls } } : {};

    const searchParams = request.nextUrl.searchParams;
    if (searchParams.has('assetIds')) {
      if (['page', 'limit', 'source', 'type'].some((key) => searchParams.has(key))) {
        return NextResponse.json({ error: 'assetIds 查询不能与分页或其他筛选条件同时使用' }, { status: 400 });
      }
      const requestedIds = searchParams.getAll('assetIds').flatMap((value) => value.split(',')).map((id) => id.trim());
      const assetIds = Array.from(new Set(requestedIds));
      if (requestedIds.length === 0 || requestedIds.length > 80 || assetIds.some((id) => !id)) {
        return NextResponse.json({ error: 'assetIds 查询最多支持 80 个有效素材编号' }, { status: 400 });
      }

      const assets = await prisma.asset.findMany({
        where: { id: { in: assetIds }, owner_id: user.id, status: 'active', type: 'image', ...visibleWhere },
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
      });
      return NextResponse.json({ assets: assets.map(serializeAsset) });
    }

    const page = clampPage(request.nextUrl.searchParams.get('page'));
    const limit = clampLimit(request.nextUrl.searchParams.get('limit'));
    const type = parseHistoryAssetType(request.nextUrl.searchParams.get('type'));
    const skip = (page - 1) * limit;
    const source = request.nextUrl.searchParams.get('source');
    let sourceIds: string[] | undefined;
    let sourceTotal: number | undefined;
    if (type === 'image' && (source === 'generated' || source === 'uploaded')) {
      const generated = Prisma.sql`(EXISTS (SELECT 1 FROM ImageStudioTask t WHERE t.asset_id = a.id AND t.owner_id = ${user.id} AND t.status = 'succeeded') OR CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json, '$.source') IN ('image_generation_api', 'workspace_generation') ELSE 0 END)`;
      const privacy = hiddenUrls.length ? Prisma.sql`AND a.original_url NOT IN (${Prisma.join(hiddenUrls)})` : Prisma.empty;
      const condition = Prisma.sql`a.owner_id = ${user.id} AND a.status = 'active' AND a.type = 'image' ${privacy} AND ${source === 'generated' ? generated : Prisma.sql`NOT COALESCE(${generated}, 0)`}`;
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT a.id FROM Asset a WHERE ${condition} ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${skip}`);
      const totals = await prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT COUNT(*) AS total FROM Asset a WHERE ${condition}`);
      sourceIds = rows.map(row => row.id);
      sourceTotal = Number(totals[0]?.total || 0);
    }

    const where = {
      owner_id: user.id,
      ...visibleWhere,
      status: 'active',
      ...(type === 'all' ? {} : { type }),
      ...(sourceIds ? { id: { in: sourceIds } } : {}),
    };

    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: sourceIds ? 0 : skip,
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
      sourceTotal !== undefined ? Promise.resolve(sourceTotal) : prisma.asset.count({ where }),
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
