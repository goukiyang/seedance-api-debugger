import type { NextRequest } from 'next/server';
import { isIP } from 'node:net';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { isExternalUser } from '@/lib/access/external-role';
import { apiRateLimiter } from '@/lib/security/rate-limit-store.server';
import { PublicApiError, withApiErrors } from './api-error';

type RatePolicy = false | 'auth' | 'login' | 'registration-code' | 'feedback';
type Access = { access: 'public' }
  | { access: 'user' | 'internal' | 'admin'; identity?: (request: NextRequest) => Promise<SessionUser | null>; unauthenticatedStatus?: 401 | 403 | 404 }
  | { access: 'service'; authenticate: (request: NextRequest) => Promise<boolean | Response> };
export type RouteOptions = Access & { rateLimit: RatePolicy };
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

async function identityFields(request: NextRequest) {
  const copy = request.clone();
  const reader = copy.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        void reader.cancel().catch(() => {});
        void request.body?.cancel().catch(() => {});
        throw new PublicApiError('请求内容过大', 413);
      }
      chunks.push(value);
    }
  }
  const bytes = Buffer.concat(chunks);
  const contentType = request.headers.get('content-type') || '';
  let body: Record<string, unknown>;
  try {
    body = /application\/x-www-form-urlencoded|multipart\/form-data/i.test(contentType)
      ? Object.fromEntries(await new Response(new Uint8Array(bytes), { headers: { 'Content-Type': contentType } }).formData())
      : JSON.parse(bytes.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    // IP limits still apply; the handler owns payload validation and feature availability.
    return { identifier: '', email: '' };
  }
  const text = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 512) : '';
  return { identifier: text(body.identifier), email: text(body.email) };
}

export function route<Args extends unknown[]>(options: RouteOptions,
  handler: (...args: Args) => Response | Promise<Response>) {
  return withApiErrors(async (...args: Args extends [] ? [request?: NextRequest] : Args) => {
    const request = args[0] as NextRequest;
    const handlerArgs = args as unknown as Args;
    if (options.access === 'service') {
      const authenticated = await options.authenticate(request);
      if (authenticated instanceof Response) return authenticated;
      if (authenticated !== true) return Response.json({ error: '未授权' }, { status: 401, headers: privateHeaders });
    } else if (options.access !== 'public') {
      const user = await (options.identity ? options.identity(request) : getSession());
      if (!user) {
        const status = options.unauthenticatedStatus ?? 401;
        return Response.json({ error: status === 404 ? '不存在' : '未登录' }, { status, headers: privateHeaders });
      }
      if (options.access === 'admin' && user.role !== 'admin'
        || options.access === 'internal' && isExternalUser(user)) {
        return Response.json({ error: '权限不足' }, { status: 403, headers: privateHeaders });
      }
    }
    if (!options.rateLimit) return handler(...handlerArgs);
    // nginx overwrites X-Real-IP. Never trust the client-controlled forwarded chain.
    const suppliedIp = request.headers.get('x-real-ip') || '';
    const ip = isIP(suppliedIp) ? suppliedIp : 'unknown-proxy-source';
    if (options.rateLimit === 'login' || options.rateLimit === 'registration-code') {
      const source = await apiRateLimiter.auth(ip);
      if (!source.allowed) return Response.json({ error: '操作过于频繁，请稍后重试', code: 'RATE_LIMITED' },
        { status: 429, headers: { ...privateHeaders, 'Retry-After': String(Math.ceil(source.retryAfterMs / 1000)) } });
    }
    const fields = options.rateLimit === 'login' || options.rateLimit === 'registration-code'
      ? await identityFields(request) : { identifier: '', email: '' };
    const anonymousFeedback = options.rateLimit === 'feedback' && !(await getSession());
    const decision = options.rateLimit === 'login' ? await apiRateLimiter.beforeLogin(fields.identifier, ip, true)
      : options.rateLimit === 'registration-code' ? await apiRateLimiter.registrationCode(fields.email, ip)
        : anonymousFeedback ? await apiRateLimiter.feedback(ip)
          : options.rateLimit === 'auth' ? await apiRateLimiter.auth(ip) : null;
    if (decision && !decision.allowed) return Response.json({ error: '操作过于频繁，请稍后重试', code: 'RATE_LIMITED' },
      { status: 429, headers: { ...privateHeaders, 'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)) } });
    if (decision?.delayMs) await new Promise(resolve => setTimeout(resolve, decision.delayMs));
    const response = await handler(...handlerArgs);
    if (options.rateLimit === 'login') {
      const succeeded = response.ok || response.status === 303 && response.headers.has('set-cookie');
      const location = response.headers.get('location');
      const invalidCredentials = response.status === 401 || !succeeded && response.status === 303
        && Boolean(location && new URL(location, request.url).searchParams.get('error') === 'invalid');
      await apiRateLimiter.afterLogin(fields.identifier, ip, { succeeded, invalidCredentials });
    }
    return response;
  });
}
