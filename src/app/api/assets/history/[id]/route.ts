import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const asset = await prisma.asset.findUnique({
      where: { id: params.id },
      select: { id: true, owner_id: true, type: true, status: true },
    });
    if (!asset || asset.type !== 'image') {
      return NextResponse.json({ error: '图片不存在' }, { status: 404 });
    }
    if (asset.owner_id !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: '无权删除此图片' }, { status: 403 });
    }
    if (asset.status !== 'active') {
      return NextResponse.json({ success: true, hidden: true });
    }

    await prisma.asset.update({
      where: { id: asset.id },
      data: { status: 'hidden' },
    });

    return NextResponse.json({ success: true, hidden: true });
  } catch (error) {
    console.error('[AssetHistory] Hide error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
