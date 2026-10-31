import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { StudioError, studioBusinessErrorStatus } from '@/lib/image-studio/tasks';

export const labPrivateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
export async function requireLabUser() {
  const user = await getSession();
  if (!user) throw new StudioError('请先登录', 401);
  if (user.status !== 'active' || !canUseCompanyTemplates(user)) throw new StudioError('当前账号没有图片生成资格', 403);
  return user;
}
export function labFailure(error: unknown, submitted?: boolean | null) {
  const typed = error instanceof Error ? error as Error & { status?: unknown } : null;
  const known = studioBusinessErrorStatus(error);
  const status = known || (typeof typed?.status === 'number' && [401, 429, 503].includes(typed.status) ? typed.status : 503);
  if (!known && status === 503) console.error('[CharacterLab]', error instanceof Error ? error.message : 'Operation failed');
  return NextResponse.json({ error: typed && (known || typeof typed.status === 'number') ? typed.message : '操作结果暂未确认，工作现场保留，请查询原记录',
    ...(submitted !== undefined ? { submitted } : {}) }, { status, headers: labPrivateHeaders });
}
