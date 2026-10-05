import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { readStudioImage } from '@/lib/image-studio/media';
import { studioVisibleAssetWhere } from '@/lib/image-studio/protected-assets';
import { STUDIO_BATCH_LIMITS, safeBatchFileName } from '@/lib/image-studio/batch-contract';
import { studioBatchView } from '@/lib/image-studio/batches';

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
    const visible = await studioVisibleAssetWhere(user);
    const batchId = request.nextUrl.searchParams.get('batchId');
    const batch = batchId ? await studioBatchView(user.id, batchId) : null;
    const files: Array<{ name: string; url: string; size: number; taskId: string }> = [];
    for (const id of ids) {
      const task = tasks.find(item => item.id === id)!;
      const asset = await prisma.asset.findFirst({ where: { id: task.asset_id!, owner_id: user.id, status: 'active', AND: [visible] } });
      if (!asset || asset.mime_type !== 'image/png' || !asset.file_size || asset.file_size > 96 * 1024 * 1024) throw new Error('图片文件不可用');
      const item = batch?.items?.find(item => item.taskId === task.id);
      if (batch && !item) throw new Error('图片不属于本批');
      files.push({ name: item ? safeBatchFileName(batch!.id, item.ordinal, item.sourceName) : `image-${task.id.slice(0, 10)}-${task.ordinal}.png`, url: asset.original_url, size: asset.file_size, taskId: task.id });
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > STUDIO_BATCH_LIMITS.zipBytes) return NextResponse.json({ error: '本包超过 128MB，请减少图片数量后保存' }, { status: 400 });
    if (files.length === 1 && !batch) return new Response(new Uint8Array(await readStudioImage(files[0].url, request.signal)), { headers: {
      'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="${files[0].name}"`, 'Cache-Control': 'private, no-store',
    } });
    const zip = new ZipFile();
    const output = zip.outputStream as Readable;
    const prefix = batch ? `batch-${batch.id.slice(0, 12)}/` : '';
    // yazl opens the next entry lazily: at most one bounded image is buffered.
    for (const file of files) zip.addReadStreamLazy(`${prefix}${file.name}`, { compress: false, size: file.size }, callback => {
      void readStudioImage(file.url, request.signal).then(bytes => {
        if (bytes.length !== file.size) throw new Error('图片大小发生变化');
        callback(null, Readable.from([bytes]));
      }).catch(error => callback(error, undefined as never));
    });
    if (batch) zip.addBuffer(Buffer.from(JSON.stringify({ batch: batch.id, createdAt: batch.createdAt, generated: batch.generated, total: batch.total, providedForDownload: files.length,
      items: batch.items?.map(item => ({ ordinal: item.ordinal, source: item.sourceName, task: item.taskId, generation: item.status, file: files.find(file => file.taskId === item.taskId)?.name || null, save: files.some(file => file.taskId === item.taskId) ? 'provided-for-download-not-confirmed-on-device' : 'not-in-this-package' })) }, null, 2)), `${prefix}results.json`);
    zip.on('error', error => output.destroy(error));
    const abort = () => output.destroy(new Error('下载已取消'));
    request.signal.addEventListener('abort', abort, { once: true });
    output.once('close', () => request.signal.removeEventListener('abort', abort));
    zip.end();
    return new Response(Readable.toWeb(output) as ReadableStream, { headers: {
      'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="generated-images.zip"', 'Cache-Control': 'private, no-store',
    } });
  } catch { return NextResponse.json({ error: '图片包准备失败，请重试；已有图片不会丢失' }, { status: 503 }); }
}
