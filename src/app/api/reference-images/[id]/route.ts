import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import {
  assertCanEditAlbum,
  assertCanViewReferenceImage,
} from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const image = await assertCanViewReferenceImage(user, params.id);
    return NextResponse.json({
      image: {
        id: image.id,
        album_id: image.album_id,
        asset_id: image.asset_id,
        source_type: image.source_type,
        source_content_id: image.source_content_id,
        source_image_id: image.source_image_id,
        sort_order: image.sort_order,
        status: image.status,
        created_at: image.created_at,
        updated_at: image.updated_at,
        image_url: `/api/reference-images/${image.id}/content`,
        thumbnail_url: `/api/reference-images/${image.id}/content?variant=thumbnail`,
        asset: image.asset ? {
          id: image.asset.id,
          type: image.asset.type,
          file_name: image.asset.file_name,
          width: image.asset.width,
          height: image.asset.height,
          file_size: image.asset.file_size,
          mime_type: image.asset.mime_type,
        } : null,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ReferenceImages] Detail error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const image = await prisma.referenceImage.findUnique({ where: { id: params.id } });
    if (!image) return NextResponse.json({ error: '参考图不存在' }, { status: 404 });
    await assertCanEditAlbum(user, image.album_id);

    await prisma.referenceImage.update({
      where: { id: params.id },
      data: { status: 'deleted' },
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_image_delete',
        target_type: 'ReferenceImage',
        target_id: params.id,
        detail: JSON.stringify({ album_id: image.album_id }),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ReferenceImages] Delete error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
