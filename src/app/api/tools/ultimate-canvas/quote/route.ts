import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { getCanvasImageQuote, parseCanvasQuoteInput } from '@/lib/canvas-quote';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BODY_BYTES = 4096;
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

async function readInput(request: NextRequest) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new AuthError('请使用 JSON 报价参数', 415);
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new AuthError('报价参数过长', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError('报价参数为空', 400);
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AuthError('报价参数过长', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new AuthError('报价参数不是有效 JSON', 400); }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) throw new AuthError('未登录', 401);
    assertInternalOnly(user, '外部账号无权使用无线画布。');
    const input = parseCanvasQuoteInput(await readInput(request));
    return NextResponse.json(await getCanvasImageQuote(user, input), { headers });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    return NextResponse.json({ error: '报价暂时不可用，请稍后重试' }, { status: 503, headers });
  }
}
