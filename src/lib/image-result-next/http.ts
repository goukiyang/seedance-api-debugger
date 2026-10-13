import { getSession } from '@/lib/auth/session';
import { ImageResultNextError } from './server';

export const imageNextJson = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
export async function imageNextUser(request: Request) {
  const user = await getSession();
  if (!user) throw new ImageResultNextError('请登录后重新打开这张结果；不会自动提交', 401);
  if (!['GET', 'HEAD'].includes(request.method)) {
    let origin: URL;
    try { origin = new URL(request.headers.get('origin') || ''); } catch { throw new ImageResultNextError('请在本站操作', 403); }
    if (!['https:', 'http:'].includes(origin.protocol) || origin.host !== request.headers.get('host')) throw new ImageResultNextError('请在本站操作', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ImageResultNextError('请求格式无效', 415);
  }
  return user;
}
export async function imageNextBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') || 0) > 12_000) throw new ImageResultNextError('导入内容过大');
  const reader = request.body?.getReader();
  if (!reader) throw new ImageResultNextError('请求格式无效');
  const decoder = new TextDecoder();
  let raw = '', bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 12_000) { await reader.cancel(); throw new ImageResultNextError('导入内容过大'); }
    raw += decoder.decode(chunk.value, { stream: true });
  }
  raw += decoder.decode();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ImageResultNextError('请求格式无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ImageResultNextError('请求格式无效');
  return value as Record<string, unknown>;
}
export function imageNextError(error: unknown) {
  if (error instanceof ImageResultNextError) return imageNextJson({ error: error.message }, error.status);
  return imageNextJson({ error: '图片导入暂未确认，原图和已有记录保留；请查询同一次导入后继续' }, 503);
}
