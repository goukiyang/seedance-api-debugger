import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { multiviewInfo, multiviewFrame, multiviewExport, multiviewFailure } from '@/lib/video/multiview';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
async function boundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader || Number(request.headers.get('content-length')) > 4096) { await reader?.cancel(); return null; }
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length; if (length > 4096) return null;
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => undefined); }
}
export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  try {
    const frame = request.nextUrl.searchParams.get('frame');
    const version = request.nextUrl.searchParams.get('version');
    if (frame !== null) {
      if (!/^\d{1,6}$/.test(frame) || !version || !/^[a-f0-9]{64}$/.test(version)) return NextResponse.json({ error: '帧位置无效' }, { status: 400, headers });
      const data = await multiviewFrame(user, params.id, request, version, Number(frame));
      return new NextResponse(new Uint8Array(data), { headers: { ...headers, 'Content-Type': 'image/png', 'Content-Length': String(data.length) } });
    }
    return NextResponse.json({ info: await multiviewInfo(user, params.id, request) }, { headers });
  } catch (error) { const failure = multiviewFailure(error); return NextResponse.json({ error: failure.message }, { status: failure.status, headers }); }
});
export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  const origin = request.headers.get('origin');
  let sameOrigin = false;
  try { sameOrigin = Boolean(origin && new URL(origin).host === request.headers.get('host')); } catch {}
  if (!sameOrigin) return NextResponse.json({ error: '请求来源无效' }, { status: 403, headers });
  try {
    const raw = await boundedBody(request);
    if (!raw) return NextResponse.json({ error: '导出设置无效或过大' }, { status: 413, headers });
    const result = await multiviewExport(user, params.id, request, JSON.parse(raw));
    return new NextResponse(new Uint8Array(result.data), { headers: { ...headers, 'Content-Type': result.mime, 'Content-Length': String(result.data.length),
      'Content-Disposition': `attachment; filename="${result.name}"` } });
  } catch (error) { const failure = multiviewFailure(error); return NextResponse.json({ error: failure.message }, { status: failure.status, headers }); }
});
