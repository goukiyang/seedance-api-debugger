import { route as declaredRoute } from '@/lib/http/route';
import { CreationError } from '@/lib/creation/contract';
import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { CanvasVideoBatchError } from '@/lib/canvas-video-batches-guards';
import { canvasBatchObject } from '@/lib/canvas-video-batch-contract';
import { quoteCanvasVideoBatch, prepareCanvasVideoBatch, queryCanvasVideoBatches } from '@/lib/canvas-video-batches';
import { videoPricingError } from '@/lib/pricing/video';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const json = (body: unknown, status = 200) => NextResponse.json(body, { status,
  headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
function failure(error: unknown) {
  if (error instanceof CreationError) return json({ error: error.message, code: error.code, field: error.field, action: error.action }, error.status);
  if (error instanceof CanvasVideoBatchError) return json({ error: error.message, code: error.code, ...error.details }, error.status);
  if (error instanceof AuthError) return json({ error: error.message }, error.status);
  const pricing = videoPricingError(error);
  if (pricing) return json({ error: pricing.message, code: pricing.code }, pricing.status);
  return json({ error: '原视频批次暂时无法确认，请保留原请求编号后查询', code: 'canvas_video_batch_unconfirmed' }, 503);
}
async function actor(request: NextRequest) {
  const user = await getSession();
  if (!user) throw new AuthError('未登录', 401);
  const expected = request.headers.get('x-app-session-user');
  if (expected && expected !== user.id) throw new CanvasVideoBatchError('账号已变化，请保留输入并重新确认账号', 409, 'pricing_actor_changed');
  return user;
}
export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  try { return json(await queryCanvasVideoBatches(await actor(request), request.nextUrl.searchParams)); }
  catch (error) { return failure(error); }
});
export const POST = declaredRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  try {
    const user = await actor(request);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new AuthError('请使用 JSON 参数', 415);
    const reader = request.body?.getReader();
    if (!reader) throw new AuthError('缺少请求参数', 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 524288) throw new AuthError('批次输入过大', 413);
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AuthError('请求内容不是有效 JSON', 400); }
    if (!canvasBatchObject(body)) throw new AuthError('请求参数无效', 400);
    if (body.action === 'quote') return json(await quoteCanvasVideoBatch(user, body));
    if (body.action === 'prepare') return json(await prepareCanvasVideoBatch(user, body));
    throw new AuthError('批次操作无效', 400);
  } catch (error) { return failure(error); }
});
