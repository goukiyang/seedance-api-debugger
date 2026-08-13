import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import {
  assertCanViewReferenceImage,
  canDownloadOriginal,
  canUseAlbumImage,
} from '@/lib/reference-albums/permissions';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const image = await assertCanViewReferenceImage(user, params.id);
    const variant = request.nextUrl.searchParams.get('variant') === 'thumbnail' ? 'thumbnail' : 'original';
    const assetType = image.asset?.type || 'image';
    const isOriginalMediaPreview = variant === 'thumbnail' && assetType !== 'image' && !image.thumbnail_url;

    if (variant === 'original' && !(await canDownloadOriginal(user, image))) {
      return NextResponse.json({ error: '无权访问原素材' }, { status: 403 });
    }

    if (
      isOriginalMediaPreview
      && !(await canUseAlbumImage(user, image))
      && !(await canDownloadOriginal(user, image))
    ) {
      return NextResponse.json({ error: '无权预览原始视频/音频素材' }, { status: 403 });
    }

    const sourceUrl = variant === 'thumbnail'
      ? (image.thumbnail_url || image.url)
      : image.url;
    const contentType = image.asset?.mime_type || 'image/jpeg';

    const siteUploadPath = siteUploadPathFromUrl(sourceUrl);
    if (siteUploadPath || sourceUrl.startsWith('/')) {
      const publicRoot = path.resolve(process.cwd(), 'public');
      const relativePath = (siteUploadPath || sourceUrl).replace(/^\/+/, '');
      const filePath = path.resolve(publicRoot, relativePath);
      if (!filePath.startsWith(`${publicRoot}${path.sep}`)) {
        return NextResponse.json({ error: '素材路径非法' }, { status: 400 });
      }
      if (!fs.existsSync(filePath)) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
      const buffer = fs.readFileSync(filePath);
      return new NextResponse(buffer, {
        headers: {
          'content-type': contentType,
          'cache-control': 'private, no-store',
        },
      });
    }

    const upstream = await fetch(sourceUrl, { cache: 'no-store' });
    if (!upstream.ok) {
      return NextResponse.json({ error: '素材读取失败' }, { status: upstream.status });
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    return new NextResponse(buffer, {
      headers: {
        'content-type': upstream.headers.get('content-type') || contentType,
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ReferenceImages] Content error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
