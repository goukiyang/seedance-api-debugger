import { getSession } from '@/lib/auth/session';
import { deleteSkill, listSkills, saveSkill } from '@/lib/image-studio/skills';
import { StudioStyleError } from '@/lib/image-studio/style-groups';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
async function handle(request: Request) {
  try {
    const user = await getSession();
    if (!user) return Response.json({ error: '请先登录' }, { status: 401, headers });
    if (request.method === 'GET') return Response.json({ skills: await listSkills(user) }, { headers });
    if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: '请求来源无效' }, { status: 403, headers });
    if (Number(request.headers.get('content-length') || 0) > 64 * 1024) throw new StudioStyleError('skills内容过大');
    const reader = request.body?.getReader();
    if (!reader) throw new StudioStyleError('skills内容无效');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > 64 * 1024) { await reader.cancel(); throw new StudioStyleError('skills内容过大'); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioStyleError('skills内容无效');
    if (request.method === 'DELETE') { await deleteSkill(user, body); return Response.json({ ok: true }, { headers }); }
    return Response.json(await saveSkill(user, body), { headers });
  } catch (error) { return Response.json({ error: error instanceof StudioStyleError ? error.message : error instanceof SyntaxError ? 'skills内容无效' : 'skills操作尚未确认，请重新读取' }, { status: error instanceof StudioStyleError ? error.status : error instanceof SyntaxError ? 400 : 503, headers }); }
}
export const GET = handle, POST = handle, PUT = handle, DELETE = handle;
