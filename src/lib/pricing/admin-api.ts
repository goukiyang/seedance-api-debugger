import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { PRICING_ADMIN_LIMITS, type PricingAdminActor, type PricingAdminFilter } from './admin-contract';
import { PricingAdminServiceError } from './policy';
import { PricingNumberError } from './math';
import { PricingRuleConflict } from './resolve';
import { PRICING_ADMIN_WRITES_ENABLED } from './build-mode';

export const pricingAdminHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };

export async function pricingAdminRoute(request: NextRequest, mutate: boolean,
  action: (actor: PricingAdminActor, body: unknown) => Promise<unknown>) {
  try {
    const admin = await getAdminUser(request);
    const owner = request.headers.get('x-app-session-user');
    if (owner !== null && owner !== admin.id) throw new PricingAdminServiceError('账号已变化，请重新打开费率设置', 409, 'pricing_actor_changed');
    let body: unknown;
    if (mutate) {
      if (!PRICING_ADMIN_WRITES_ENABLED) throw new PricingAdminServiceError('费率设置正在维护，未执行新的修改；已保存价格和原操作回执保留', 503, 'pricing_admin_read_only');
      let origin: URL;
      try { origin = new URL(request.headers.get('origin') || ''); } catch { throw new AuthError('请在本站操作', 403); }
      if (!['https:', 'http:'].includes(origin.protocol) || origin.host !== request.headers.get('host')
        || request.headers.get('sec-fetch-site') === 'cross-site') throw new AuthError('请求来源无效', 403);
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) throw new PricingAdminServiceError('请提交 JSON 内容', 415, 'pricing_content_type');
      const reader = request.body?.getReader();
      if (!reader) throw new PricingAdminServiceError('请求内容为空');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > PRICING_ADMIN_LIMITS.maxRequestBytes) { await reader.cancel(); throw new PricingAdminServiceError('费率请求超过 1MiB，未截断保存', 413, 'pricing_request_too_large'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new PricingAdminServiceError('请求 JSON 无法读取'); }
    }
    const result = await action({ id: admin.id, displayName: admin.name || admin.username, avatarUrl: admin.avatar_url || null }, body);
    return result instanceof Response ? result : NextResponse.json(result, { headers: pricingAdminHeaders });
  } catch (error) {
    if (error instanceof PricingAdminServiceError) return NextResponse.json({ error: error.message, code: error.code,
      ...(error.fields ? { fields: error.fields } : {}), ...(error.currentRevision ? { currentRevision: error.currentRevision } : {}) }, { status: error.status, headers: pricingAdminHeaders });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message, code: 'pricing_unauthorized' }, { status: error.status, headers: pricingAdminHeaders });
    if (error instanceof PricingNumberError || error instanceof PricingRuleConflict) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: pricingAdminHeaders });
    return NextResponse.json({ error: '费率结果暂时无法确认，请保留修改；保存请求请查询原操作编号', code: 'pricing_unavailable' }, { status: 503, headers: pricingAdminHeaders });
  }
}

export function pricingAdminFilterFromUrl(url: URL): PricingAdminFilter {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Array.from(url.searchParams.entries())) {
    if (!['kind', 'search', 'channelId', 'defaultsOnly', 'difference', 'basisKind'].includes(key) || Object.hasOwn(result, key)) throw new PricingAdminServiceError('导出筛选条件无效');
    result[key] = key === 'defaultsOnly' ? value === 'true' ? true : value === 'false' ? false : undefined : value;
    if (result[key] === undefined) throw new PricingAdminServiceError('导出筛选条件无效');
  }
  return result as PricingAdminFilter;
}
