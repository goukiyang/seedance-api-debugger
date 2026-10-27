import { openUntrustedImage } from '@/lib/media/decode-image';
import { readFile } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { multiviewWorkRoute, multiviewWorkHeaders } from './multiview-work-api';
import { assertMultiviewShareAccess, assertMultiviewSourceReference } from './multiview-source.server';
import { multiviewInfo, multiviewFrame, multiviewExport, multiviewPreviewManifest, multiviewPreviewAtlas, multiviewSourceFile } from './multiview';
import type { MultiviewSourceAccess } from './multiview-work-contract';

export function multiviewSourceRoute(request: NextRequest, access: MultiviewSourceAccess, mode: 'source' | 'previews' | 'video' = 'source') {
  return multiviewWorkRoute(request, request.method === 'POST', async (user, body) => {
    const task = async () => {
      if (access.kind === 'share') return (await assertMultiviewShareAccess(user, access.id)).share.source_task_id;
      const work = await prisma.multiviewWork.findUnique({ where: { id: access.id } });
      if (!work || work.removed_at) throw new AuthError('方案不存在或已移出。', 404);
      await assertMultiviewSourceReference(user, work);
      return work.source_task_id;
    };
    const taskId = await task(), params = request.nextUrl.searchParams;
    const version = params.get('version');
    if (mode === 'video') {
      const info = await multiviewInfo(user, taskId, request, access);
      if (version && version !== info.sourceVersion) throw new AuthError('来源版本已变化。', 409);
      const source = await multiviewSourceFile(user, taskId, info.sourceVersion, access);
      const bytes = await readFile(source.file);
      await task();
      const range = request.headers.get('range');
      let start = 0, end = bytes.length - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || !match[1] && !match[2]) return new NextResponse(null, { status: 416, headers: { ...multiviewWorkHeaders, 'Content-Range': `bytes */${bytes.length}` } });
        if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) return new NextResponse(null, { status: 416, headers: multiviewWorkHeaders });
      }
      return new NextResponse(request.method === 'HEAD' ? null : new Uint8Array(bytes.subarray(start, end + 1)), { status: range ? 206 : 200,
        headers: { ...multiviewWorkHeaders, 'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
    }
    if (request.method === 'POST') {
      const result = await multiviewExport(user, taskId, request, body, access);
      await task();
      return new NextResponse(new Uint8Array(result.data), { headers: { ...multiviewWorkHeaders, 'Content-Type': result.mime,
        'Content-Length': String(result.data.length), 'Content-Disposition': `attachment; filename="${result.name}"` } });
    }
    if (mode === 'previews') {
      if (!version || !/^[a-f0-9]{64}$/.test(version)) throw new AuthError('视频版本无效。', 400);
      const chunk = params.get('chunk');
      if (chunk === null) return { manifest: (await multiviewPreviewManifest(user, taskId, request, version, access)).manifest };
      if (!/^\d{1,4}$/.test(chunk)) throw new AuthError('预览位置无效。', 400);
      const result = await multiviewPreviewAtlas(user, taskId, request, version, Number(chunk), access);
      await task();
      return new NextResponse(new Uint8Array(result.data), { headers: { ...multiviewWorkHeaders, 'Content-Type': 'image/jpeg' } });
    }
    const frame = params.get('frame');
    if (frame !== null) {
      if (!/^\d{1,6}$/.test(frame) || !version || !/^[a-f0-9]{64}$/.test(version)) throw new AuthError('帧位置无效。', 400);
      let bytes: Buffer = await multiviewFrame(user, taskId, request, version, Number(frame), access);
      const thumbnail = params.get('thumbnail') === '1';
      if (thumbnail) bytes = await (await openUntrustedImage(bytes, 'ordinary')).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      await task();
      return new NextResponse(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { ...multiviewWorkHeaders, 'Content-Type': thumbnail ? 'image/webp' : 'image/png', 'Content-Length': String(bytes.length) } });
    }
    return { info: await multiviewInfo(user, taskId, request, access) };
  });
}
