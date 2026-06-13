import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

function clampPage(value: string | null) {
  const page = Number(value || '1');
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function clampLimit(value: string | null) {
  const limit = Number(value || '40');
  if (!Number.isFinite(limit) || limit <= 0) return 40;
  return Math.min(80, Math.max(12, Math.floor(limit)));
}

function serializeAsset(asset: {
  id: string;
  original_url: string;
  thumbnail_url: string | null;
  file_name: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  file_size: number;
  created_at: Date;
}) {
  return {
    id: asset.id,
    originalUrl: asset.original_url,
    thumbnailUrl: asset.thumbnail_url || asset.original_url,
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
    const skip = (page - 1) * limit;

    const where = {
      owner_id: user.id,
      type: 'image',
      status: 'active',
    };

    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
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
