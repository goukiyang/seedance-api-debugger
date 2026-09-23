import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACCESS_CHECK_HEADER = 'x-image-studio-upload-access-check';

export async function GET(request: NextRequest) {
  if (request.headers.get(ACCESS_CHECK_HEADER) !== '1') {
    return new NextResponse(null, { status: 404 });
  }

  const pathname = request.nextUrl.searchParams.get('path') || '';
  if (!pathname.startsWith('/uploads/assets/') && !pathname.startsWith('/uploads/thumbs/')) {
    return new NextResponse(null, { status: 204 });
  }

  const assets = await prisma.asset.findMany({
    where: { OR: [{ original_url: pathname }, { thumbnail_url: pathname }] },
    select: { id: true },
  });
  if (!assets.length) return new NextResponse(null, { status: 204 });

  const generatedTasks = await prisma.imageStudioTask.findMany({
    where: { asset_id: { in: assets.map(asset => asset.id) }, status: 'succeeded' },
    select: { owner_id: true, deleted_at: true },
  });
  if (!generatedTasks.length) return new NextResponse(null, { status: 204 });

  const user = await getSession();
  if (user?.role === 'admin' || generatedTasks.some(task => task.owner_id === user?.id && !task.deleted_at)) {
    return new NextResponse(null, { status: 204 });
  }
  return new NextResponse(null, { status: 404 });
}
