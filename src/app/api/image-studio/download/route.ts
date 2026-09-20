import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { readStudioImage } from '@/lib/image-studio/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const ids = Array.from(new Set(request.nextUrl.searchParams.getAll('id')));
  if (!ids.length || ids.length > 8) return NextResponse.json({ error: '每次请选择 1 至 8 张图片' }, { status: 400 });
  const tasks = await prisma.imageStudioTask.findMany({ where: { id: { in: ids }, owner_id: user.id, status: 'succeeded', deleted_at: null } });
  if (tasks.length !== ids.length) return NextResponse.json({ error: '部分图片不可下载或无权访问' }, { status: 403 });
  try {
    const files: Array<{ name: string; bytes: Buffer }> = [];
    for (const id of ids) {
      const task = tasks.find(item => item.id === id)!;
      const asset = await prisma.asset.findFirst({ where: { id: task.asset_id!, owner_id: user.id, status: 'active' } });
      if (!asset) throw new Error('图片文件不可用');
      files.push({ name: `image-${task.id.slice(0, 10)}-${task.ordinal}.png`, bytes: await readStudioImage(asset.original_url) });
    }
    if (files.length === 1) return new Response(new Uint8Array(files[0].bytes), { headers: {
      'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="${files[0].name}"`, 'Cache-Control': 'private, no-store',
    } });
    const zip = new ZipFile();
    for (const file of files) zip.addBuffer(file.bytes, file.name);
    zip.end();
    return new Response(Readable.toWeb(zip.outputStream as Readable) as ReadableStream, { headers: {
      'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="generated-images.zip"', 'Cache-Control': 'private, no-store',
    } });
  } catch { return NextResponse.json({ error: '图片包准备失败，请重试；已有图片不会丢失' }, { status: 503 }); }
}
