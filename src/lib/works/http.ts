import { AuthError } from '@/lib/auth/session';
import { WorkError } from './types';
export const workHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export function workRouteError(error: unknown) {
  if (error instanceof WorkError || error instanceof AuthError) return Response.json({ error: error.message, ...(error instanceof WorkError ? { code: error.code } : {}) }, { status: error.status, headers: workHeaders });
  console.error('[works] request deferred', error instanceof Error ? error.name : 'unknown');
  return Response.json({ error: '作品暂时无法读取，请稍后重试；原内容与操作记录保留' }, { status: 503, headers: workHeaders });
}
