import type { ReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { multiviewWorkRoute, multiviewWorkHeaders } from '@/lib/video/multiview-work-api';
import { readMultiviewWorkFile, MultiviewWorkError } from '@/lib/video/multiview-works';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workId: string; role: string }> };
async function response(request: NextRequest, context: Context, head: boolean) {
  const params = await context.params;
  return multiviewWorkRoute(request, false, async user => {
    const revision = request.nextUrl.searchParams.get('readyRevision');
    if (!revision || !/^[1-9]\d{0,9}$/.test(revision)) throw new MultiviewWorkError('作品成品版本无效。');
    const file = await readMultiviewWorkFile(user, params.workId, params.role, Number(revision));
    let stream: ReadStream | undefined;
    const abort = () => { stream?.destroy(); };
    try {
      const download = request.nextUrl.searchParams.get('download') === '1';
      const extension = file.mime === 'application/zip' ? 'zip' : file.mime === 'image/jpeg' ? 'jpg' : 'png';
      const headers = { ...multiviewWorkHeaders, 'Content-Type': file.mime, 'Content-Length': String(file.bytes), ETag: file.etag,
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="multiview-${params.workId}-${params.role}.${extension}"` };
      if (head) { await file.handle.close(); return new NextResponse(null, { headers }); }
      if (request.signal.aborted) throw new MultiviewWorkError('文件读取已取消。', 499, 'WORK_FILE_CANCELLED');
      stream = file.handle.createReadStream({ autoClose: true, start: 0, end: file.bytes - 1 });
      request.signal.addEventListener('abort', abort, { once: true });
      stream.once('close', () => request.signal.removeEventListener('abort', abort));
      // Readable.toWeb forwards response-body cancellation to stream.destroy().
      return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers });
    } catch (error) {
      request.signal.removeEventListener('abort', abort);
      stream?.destroy();
      await file.handle.close().catch(() => undefined);
      throw error;
    }
  });
}
export async function GET(request: NextRequest, context: Context) { return response(request, context, false); }
export async function HEAD(request: NextRequest, context: Context) { return response(request, context, true); }
