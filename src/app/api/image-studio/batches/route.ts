import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { createStudioBatch, listStudioBatches, studioBatchView, updateStudioBatch } from '@/lib/image-studio/batches';
import { StudioError } from '@/lib/image-studio/tasks';
import { quoteStudioBatch } from '@/lib/image-studio/batch-billing-quote';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
async function handle(request: NextRequest, write = false) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用' }, { status: 403 });
  try {
    if (write) {
      if (Number(request.headers.get('content-length') || 0) > 128 * 1024) throw new StudioError('本批提交内容过大');
      const reader = request.body?.getReader();
      if (!reader) throw new StudioError('提交内容无效');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 128 * 1024) { await reader.cancel(); throw new StudioError('本批提交内容过大'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioError('提交内容无效');
      if (request.method === 'POST' && body.action === 'quote') return NextResponse.json(await quoteStudioBatch(user.id, body), { headers: { 'Cache-Control': 'private, no-store' } });
      if (request.method === 'PATCH') { await updateStudioBatch(user.id, body); return NextResponse.json({ batch: await studioBatchView(user.id, body.id) }); }
      const id = await createStudioBatch(user.id, body);
      return NextResponse.json({ batch: await studioBatchView(user.id, id) }, { status: 202 });
    }
    const id = request.nextUrl.searchParams.get('id');
    const requestId = request.nextUrl.searchParams.get('requestId');
    if (requestId && !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new StudioError('提交编号无效');
    if (id || requestId) {
      const { createHash } = await import('node:crypto');
      return NextResponse.json({ batch: await studioBatchView(user.id, id || createHash('sha256').update(`${user.id}:${requestId}`).digest('hex')) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(await listStudioBatches(user.id, request.nextUrl.searchParams.get('cursor') || undefined), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof StudioError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: '提交内容无效' }, { status: 400 });
    return NextResponse.json({ error: write ? '操作结果待确认，请查询原批次，不要重复新建' : '批次读取失败，请重试' }, { status: 503 });
  }
}
export const GET = (request: NextRequest) => handle(request);
export const POST = (request: NextRequest) => handle(request, true);
export const PATCH = (request: NextRequest) => handle(request, true);
