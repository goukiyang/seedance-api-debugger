import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { prisma } from '@/lib/prisma';
import { readStudioImage } from '@/lib/image-studio/media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const ids = Array.from(new Set(request.nextUrl.searchParams.getAll('id')));
    if (!ids.length || ids.length > 8) return NextResponse.json({ error: '每次请选择 1 至 8 张图片' }, { status: 400 });
    const tasks = await prisma.imageStudioTask.findMany({ where: { id: { in: ids }, status: 'succeeded', asset_id: { not: null } } });
    if (tasks.length !== ids.length) return NextResponse.json({ error: '部分图片不可下载或记录不存在' }, { status: 404 });
    const assetIds = tasks.map(task => task.asset_id!).filter(Boolean);
    const assets = await prisma.asset.findMany({ where: { id: { in: assetIds } } });
    const assetById = new Map(assets.map(asset => [asset.id, asset]));
    const files: Array<{ name: string; bytes: Buffer }> = [];
    for (const id of ids) {
      const task = tasks.find(item => item.id === id)!;
      const asset = assetById.get(task.asset_id!);
      if (!asset) return NextResponse.json({ error: '图片文件不可用' }, { status: 404 });
      files.push({ name: `image-${task.owner_id.slice(0, 8)}-${task.id.slice(0, 10)}-${task.ordinal}.png`, bytes: await readStudioImage(asset.original_url) });
    }
    if (files.length === 1) return new Response(new Uint8Array(files[0].bytes), { headers: {
      'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="${files[0].name}"`, 'Cache-Control': 'private, no-store',
    } });
    const zip = new ZipFile();
    for (const file of files) zip.addBuffer(file.bytes, file.name);
    zip.end();
    return new Response(Readable.toWeb(zip.outputStream as Readable) as ReadableStream, { headers: {
      'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="image-studio-audit.zip"', 'Cache-Control': 'private, no-store',
    } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: '审计图片准备失败，请重试' }, { status: 503 });
  }
}
