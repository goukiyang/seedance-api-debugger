import { getSession } from '@/lib/auth/session';
import { listVideoPromptGroups, videoPromptGroupSelections, readVideoPromptGroupEditor,
  saveVideoPromptGroup, videoPromptGroupSaveStatus, videoPromptGroupDraft, videoPromptGroupVersions } from '@/lib/video/prompt-groups.server';
import { PrivateDraftConflict } from '@/lib/security/private-prompt-drafts.server';
import { VideoPromptGroupError } from '@/lib/video/prompt-groups';
import { PrivatePromptAccessError } from '@/lib/security/private-prompt-identity.server';
import { PrivatePromptError } from '@/lib/security/private-prompts.server';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function sameOrigin(request: Request) {
  const host = request.headers.get('host'), origin = request.headers.get('origin');
  const proto = request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '');
  if (!host || /[/\\?#@,\s]/.test(host) || !['http', 'https'].includes(proto)) return false;
  try { return origin === new URL(`${proto}://${host}`).origin; } catch { return false; }
}
async function handle(request: Request) {
  try {
    const user = await getSession();
    if (!user) return Response.json({ error: '请先登录' }, { status: 401, headers });
    if (request.method === 'GET') {
      const p = new URL(request.url).searchParams;
      if (p.get('mode') === 'save-status') return Response.json(await videoPromptGroupSaveStatus(user, p.get('requestId') || ''), { headers });
      if (p.get('mode') === 'versions') return Response.json({ versions: await videoPromptGroupVersions(user,
        { groupId: p.get('groupId') || '', versionId: p.get('versionId') || '' }) }, { headers });
      if (p.get('mode') === 'draft' || p.get('mode') === 'draft-status') return Response.json({ draft: await videoPromptGroupDraft(user,
        p.get('groupId') || '', undefined, p.get('mode') === 'draft-status' ? p.get('requestId') || '' : undefined) }, { headers });
      if (p.get('mode') === 'editor') return Response.json(await readVideoPromptGroupEditor(user,
        { groupId: p.get('groupId') || '', versionId: p.get('versionId') || '' }, p.get('latest') === '1'), { headers });
      if (p.has('refs')) {
        const raw = p.get('refs') || '[]';
        if (raw.length > 4096) throw new VideoPromptGroupError('选择内容过大', 400);
        return Response.json({ groups: await videoPromptGroupSelections(user, JSON.parse(raw)) }, { headers });
      }
      return Response.json(await listVideoPromptGroups(user, { query: p.get('query') || '',
        scope: p.get('scope') || '', cursor: p.get('cursor') || '' }), { headers });
    }
    if (!sameOrigin(request)) return Response.json({ error: '请求来源无效' }, { status: 403, headers });
    const reader = request.body?.getReader();
    if (!reader) throw new VideoPromptGroupError('保存内容无效', 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 64 * 1024) { await reader.cancel(); throw new VideoPromptGroupError('保存内容过大', 400); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new VideoPromptGroupError('保存内容无效', 400);
    if (body.action === 'save-draft') return Response.json({ draft: await videoPromptGroupDraft(user, body.groupId, body) }, { headers });
    return Response.json(await saveVideoPromptGroup(user, body), { headers });
  } catch (error) {
    if (error instanceof PrivateDraftConflict) return Response.json({ error: error.message }, { status: 409, headers });
    if (error instanceof VideoPromptGroupError || error instanceof PrivatePromptError || error instanceof PrivatePromptAccessError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    }
    return Response.json({ error: error instanceof SyntaxError ? '内容格式无效' : '提示词组暂时无法读取，请保留当前输入后重试' },
      { status: error instanceof SyntaxError ? 400 : 503, headers });
  }
}
export const GET = handle, POST = handle;
