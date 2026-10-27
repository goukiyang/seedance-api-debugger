import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { multiviewFailure, multiviewPreviewAtlas, multiviewPreviewManifest } from '@/lib/video/multiview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  const version = request.nextUrl.searchParams.get('version');
  const chunk = request.nextUrl.searchParams.get('chunk');
  if (!version || !/^[a-f0-9]{64}$/.test(version)) return NextResponse.json({ error: '原视频版本无效' }, { status: 400, headers });
  try {
    if (chunk !== null) {
      if (!/^\d{1,4}$/.test(chunk)) return NextResponse.json({ error: '预览图片位置无效' }, { status: 400, headers });
      const result = await multiviewPreviewAtlas(user, params.id, request, version, Number(chunk));
      return new NextResponse(new Uint8Array(result.data), { headers: { ...headers, 'Content-Type': 'image/jpeg',
        'Content-Length': String(result.data.length), ETag: result.etag, 'Server-Timing': `preview;dur=${result.duration.toFixed(1)}` } });
    }
    const result = await multiviewPreviewManifest(user, params.id, request, version);
    return NextResponse.json({ manifest: result.manifest }, { headers: { ...headers, 'Server-Timing': `preview;dur=${result.duration.toFixed(1)}` } });
  } catch (error) {
    const failure = multiviewFailure(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status, headers });
  }
});
