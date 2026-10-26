import { getSession } from '@/lib/auth/session';
import { deleteSkill, listSkills, listSkillsPage, parseSkillIds, saveSkill } from '@/lib/image-studio/skills';
import { StudioStyleError } from '@/lib/image-studio/style-groups';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function validRequestOrigin(request: Request) {
  const origin = request.headers.get('origin'), host = request.headers.get('host');
  if (!origin || !host || /[/\\?#@,\s]/.test(host)) return false;
  try {
    // The production proxy preserves Host and overwrites X-Forwarded-Proto.
    const forwardedProtocol = request.headers.get('x-forwarded-proto');
    if (forwardedProtocol !== null && !['http', 'https'].includes(forwardedProtocol)) return false;
    const protocol = forwardedProtocol ? `${forwardedProtocol}:` : new URL(request.url).protocol;
    if (!['http:', 'https:'].includes(protocol)) return false;
    return origin === new URL(`${protocol}//${host}`).origin;
  } catch { return false; }
}
async function handle(request: Request) {
  try {
    const user = await getSession();
    if (!user) return Response.json({ error: '请先登录' }, { status: 401, headers });
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      if (params.has('ids')) {
        const selected = parseSkillIds(params.get('ids')?.split(',').filter(Boolean) || []);
        const page = await listSkillsPage(user, { keys: selected });
        const byId = new Map(page.skills.map(skill => [skill.id, skill]));
        return Response.json({ skills: selected.map(id => byId.get(id) || { id, name: '提示词组不可用', unavailable: true }), nextCursor: null }, { headers });
      }
      if (params.get('page') === '1') return Response.json(await listSkillsPage(user, {
        cursor: params.get('cursor') || undefined, query: params.get('query') || undefined,
        ...(params.has('keys') ? { keys: params.get('keys')?.split(',').filter(Boolean) || [] } : {}),
      }), { headers });
      return Response.json({ skills: await listSkills(user) }, { headers });
    }
    if (!validRequestOrigin(request)) return Response.json({ error: '请求来源无效' }, { status: 403, headers });
    if (Number(request.headers.get('content-length') || 0) > 64 * 1024) throw new StudioStyleError('提示词组内容过大');
    const reader = request.body?.getReader();
    if (!reader) throw new StudioStyleError('提示词组内容无效');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > 64 * 1024) { await reader.cancel(); throw new StudioStyleError('提示词组内容过大'); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioStyleError('提示词组内容无效');
    if (request.method === 'DELETE') { await deleteSkill(user, body); return Response.json({ ok: true }, { headers }); }
    return Response.json(await saveSkill(user, body), { headers });
  } catch (error) { return Response.json({ error: error instanceof StudioStyleError ? error.message : error instanceof SyntaxError ? '提示词组内容无效' : '提示词组操作尚未确认，请重新读取' }, { status: error instanceof StudioStyleError ? error.status : error instanceof SyntaxError ? 400 : 503, headers }); }
}
export const GET = handle, POST = handle, PUT = handle, DELETE = handle;
