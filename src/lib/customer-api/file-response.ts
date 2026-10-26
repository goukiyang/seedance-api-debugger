import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { parsePreviewRange } from '@/lib/media/preview-response';
import { CustomerApiError } from './auth';

export async function privateFileResponse(request: Request, file: string, bytes: number, mime: string, filename?: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size !== bytes || !bytes) { await handle.close(); throw new CustomerApiError('CONTENT_UNAVAILABLE', '文件暂未就绪。', 409); }
  const rawRange = request.method === 'HEAD' ? null : request.headers.get('range');
  const range = rawRange ? parsePreviewRange(rawRange, bytes) : null;
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization', 'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes',
    ...(filename ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}) };
  if (rawRange && !range) { await handle.close(); return new NextResponse(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${bytes}` } }); }
  const responseHeaders = { ...headers, 'Content-Length': String(range ? range.end - range.start + 1 : bytes),
    ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes}` } : {}) };
  if (request.method === 'HEAD') { await handle.close(); return new NextResponse(null, { headers: responseHeaders }); }
  if (request.signal.aborted) { await handle.close(); request.signal.throwIfAborted(); }
  const stream = handle.createReadStream({ ...range, autoClose: true });
  const abort = () => stream.destroy(new Error('Request aborted'));
  request.signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => request.signal.removeEventListener('abort', abort));
  return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers: responseHeaders });
}
