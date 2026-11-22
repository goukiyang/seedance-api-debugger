import { NextRequest, NextResponse } from 'next/server';
import { getSession, AuthError } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
export const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export async function uiUser(request?: NextRequest, loadSession: typeof getSession = getSession) {
  const user = await loadSession();
  if (!user) throw new AuthError('请先登录', 401);
  if (user.status !== 'active' || user.account_type !== 'internal' || !canUseCompanyTemplates(user)) throw new AuthError('当前账号无权使用 UI 界面设计', 403);
  if (request && !['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin');
    let sameOrigin = false;
    try { sameOrigin = Boolean(origin && new URL(origin).host === request.headers.get('host')); } catch {}
    if (!sameOrigin || request.headers.get('sec-fetch-site') === 'cross-site') throw new AuthError('请从本站页面提交', 403);
  }
  const expected = request?.headers.get('x-ui-design-account');
  if (expected && expected !== user.id) throw new AuthError('账号已变化，当前草稿保留在原账号', 409);
  return user;
}
export function uiJson(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: privateHeaders }); }
export function uiFailure(error: unknown) {
  const value = error as { status?: number; statusCode?: number; code?: string; message?: string; analysisId?: string; completedFrames?: number };
  const status = value.status || value.statusCode || 503;
  return uiJson({ error: status < 500 ? value.message : '操作暂未确认，输入和原号已保留，请重试读取', code: value.code, ...(value.analysisId ? { analysisId: value.analysisId, completedFrames: value.completedFrames } : {}) }, status);
}
