import { NextRequest, NextResponse } from 'next/server';
import { getBridgeUser, isAllowedShellOrigin } from '@/lib/bridge/panel-token';
import { DirectoryError, readDirectory, updateDirectory } from '@/lib/bridge/gpt-directory';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' };
async function handle(request: NextRequest, write: boolean) {
  try {
    const user = await getBridgeUser(request);
    if (!user) return NextResponse.json({ ok: false, error: '请先登录 SD2' }, { status: 401, headers });
    if (request.headers.get('x-sd2-user-id') !== user.id) return NextResponse.json({ ok: false, error: '账号已切换，请重新读取目录' }, { status: 409, headers });
    if (write) {
      const origin = request.headers.get('origin');
      if (!origin || !isAllowedShellOrigin(origin) && new URL(origin).origin !== request.nextUrl.origin) throw new DirectoryError('来源不允许', 403);
      if (Number(request.headers.get('content-length')) > 512 * 1024) throw new DirectoryError('目录过大', 413);
      const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 512 * 1024) throw new DirectoryError('目录过大', 413);
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); } catch { throw new DirectoryError('目录格式无效'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DirectoryError('目录格式无效');
      return NextResponse.json({ ok: true, ...await updateDirectory(user.id, String(body.scope || ''), body) }, { headers });
    }
    return NextResponse.json({ ok: true, ...await readDirectory(user.id, request.nextUrl.searchParams.get('scope') || '', request.nextUrl.searchParams.get('version') || '') }, { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof DirectoryError ? error.message : '目录暂时无法同步，请稍后重试' }, { status: error instanceof DirectoryError ? error.status : 503, headers });
  }
}
export const GET = (request: NextRequest) => handle(request, false);
export const PATCH = (request: NextRequest) => handle(request, true);
