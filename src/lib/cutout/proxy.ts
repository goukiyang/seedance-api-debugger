type User = { id: string; role: string };
type Environment = Record<string, string | undefined>;
const PRIVATE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const KINDS = new Set(['cutout', 'characters', 'crop', 'split_preview', 'split_region', 'split_merge', 'split_export']);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: PRIVATE });
const failure = (code: string, message: string, status: number) => json({ success: false, error: code, message, submission_made: false }, status);

export function cutoutServiceBase(env: Environment): string {
  const url = new URL(env.CUTOUT_SERVICE_BASE_URL || env.CUTOUT_BASE_URL || 'https://cutout.youdooart.com');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) throw new Error('Invalid service configuration');
  return url.origin;
}
// 上游没有业务身份查询接口；仅接受一个已授权SD2绑定，避免不同密钥共用owner串号。
export function cutoutBusinessCredential(env: Environment, id: string): string | null {
  try {
    const bindings: unknown = JSON.parse(env.CUTOUT_BUSINESS_KEYS || 'null');
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || !Object.prototype.hasOwnProperty.call(bindings, id)) return null;
    const record = bindings as Record<string, unknown>, key = record[id];
    if (Object.keys(record).length !== 1) return null;
    if (typeof key !== 'string' || key.length < 16 || key.length > 2048 || /\s/.test(key) || Object.values(record).filter(value => value === key).length !== 1) return null;
    return key;
  } catch { return null; }
}
function safeSegment(v: string) { return v.length > 0 && v.length <= 255 && v !== '.' && v !== '..' && !/[\/\\\u0000-\u001f\u007f?#%]/.test(v); }
export function cutoutRoute(path: string[], method: string): string | null {
  if (!path.every(safeSegment)) return null;
  const plain = path.join('/'), read = ['GET', 'HEAD'].includes(method);
  if (read && ['health', 'capabilities', 'v1/capabilities'].includes(plain)) return '/api/v1/capabilities';
  if (plain === 'v1/assets' && method === 'POST') return '/api/v1/assets';
  if (plain === 'v1/jobs' && (read || method === 'POST')) return '/api/v1/jobs';
  if (plain === 'v1/jobs/history' && read) return '/api/v1/jobs/history';
  if (path.length === 3 && path[0] === 'v1' && path[1] === 'jobs' && (read || method === 'DELETE')) return `/api/v1/jobs/${encodeURIComponent(path[2])}`;
  if (path.length === 4 && path[0] === 'v1' && path[1] === 'results' && read) return `/api/v1/results/${encodeURIComponent(path[2])}/${encodeURIComponent(path[3])}`;
  if ((read && ['models', 'tasks'].includes(plain)) ||
    (method === 'POST' && ['cutout', 'characters/split-cutout', 'tasks', 'characters/tasks', 'splits', 'splits/export', 'splits/merge', 'splits/region'].includes(plain)) ||
    (read && ((path.length === 2 && ['tasks', 'result'].includes(path[0])) || (path.length === 3 && plain.startsWith('characters/tasks/')))) ||
    (method === 'DELETE' && path.length === 3 && plain.startsWith('characters/tasks/')) ||
    (method === 'POST' && path.length === 3 && path[0] === 'tasks' && path[2] === 'cancel')) return `/api/integration/${path.map(encodeURIComponent).join('/')}`;
  return null;
}
export function rewriteCutoutUrls(value: unknown, base: string, key = ''): unknown {
  if (Array.isArray(value)) return value.map(v => rewriteCutoutUrls(v, base, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteCutoutUrls(v, base, k)]));
  if (typeof value !== 'string' || !key.endsWith('_url')) return value;
  try {
    const url = new URL(value, base);
    if (url.origin !== base || url.search || url.hash) return null;
    if (url.pathname.startsWith('/api/v1/')) return `/api/cutout/v1/${url.pathname.slice(8)}`;
    if (url.pathname.startsWith('/api/integration/')) return `/api/cutout/${url.pathname.slice(17)}`;
  } catch { /* 未知或外部链接不能进入客户端 */ }
  return null;
}
const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: '抠图接入身份无效，请联系管理员检查授权；没有提交新任务',
  UPLOAD_TOO_LARGE: '图片过大，请压缩或更换图片后重试',
  INVALID_IMAGE: '图片无法读取，请更换有效图片后重试',
  PIXEL_QUOTA_EXCEEDED: '图片尺寸超过账户限制，请缩小后重试',
  ACTIVE_JOB_QUOTA_EXCEEDED: '已有任务等待完成，请稍后再提交',
  QUEUE_NOT_CONFIGURED: '抠图队列暂不可用，任务没有提交，请稍后重试',
  JOB_NOT_FOUND: '找不到当前账户的任务，请从历史记录重新打开',
  FILE_NOT_FOUND: '找不到当前账户的结果文件，请重新打开任务',
  IDEMPOTENCY_CONFLICT: '这次重试的内容已改变，请检查参数后重新提交',
};
async function upstreamFailure(response: Response, mutation = false) {
  const body = await response.json().catch(() => null);
  const code = typeof body?.detail?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.detail.code) ? body.detail.code : 'CUTOUT_UPSTREAM_ERROR';
  const message = ERROR_MESSAGES[code] || ([401, 403].includes(response.status) ? ERROR_MESSAGES.UNAUTHORIZED : response.status === 409 ? '任务状态或提交内容已改变，请重新查询后继续' : '抠图服务未完成请求，原图与已有结果保留，请重试');
  const uncertain = mutation && (response.status >= 500 || response.status < 400);
  return json({ success: false, error: code, message: uncertain ? '服务回复异常，无法确认任务是否已提交。请查询历史，或保留原参数和原提交标识重试，不要另建任务' : message,
    submission_made: uncertain ? null : false }, response.status >= 400 && response.status < 600 ? response.status : 502);
}
const fetchUpstream = (fetcher: typeof fetch, url: string, init: RequestInit, timeout = 30_000) => fetcher(url, { ...init, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(timeout) });

export async function proxyCutout(request: Request, path: string[], user: User | null, env: Environment = process.env, fetcher: typeof fetch = fetch): Promise<Response> {
  if (!user) return failure('UNAUTHENTICATED', '未登录', 401);
  if (user.role !== 'admin') return failure('FORBIDDEN', 'AI 抠图工具暂时只对管理员开放', 403);
  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin'), host = request.headers.get('host') || new URL(request.url).host;
    try { if (!origin || new URL(origin).host !== host) return failure('ORIGIN_REJECTED', '请在本站操作', 403); }
    catch { return failure('ORIGIN_REJECTED', '请在本站操作', 403); }
  }
  const targetPath = cutoutRoute(path, request.method);
  if (!targetPath) return failure('NOT_FOUND', '不支持的抠图操作', 404);
  let base: string;
  try { base = cutoutServiceBase(env); } catch { return failure('CUTOUT_CONFIGURATION_INVALID', '抠图连接配置无效，请联系管理员；没有提交任务', 503); }
  const key = cutoutBusinessCredential(env, user.id);
  try {
    if (targetPath === '/api/v1/capabilities') {
      const response = await fetchUpstream(fetcher, `${base}${targetPath}`, { method: 'GET' });
      if (!response.ok) return upstreamFailure(response);
      const payload = await response.json();
      let authorized = false;
      if (key) {
        const probe = await fetchUpstream(fetcher, `${base}/api/v1/jobs/history?limit=1&offset=0`, { headers: { 'X-API-Key': key } });
        authorized = probe.ok; await probe.body?.cancel();
      }
      const worker = payload.worker, ready = authorized && worker?.online === true && worker?.paused !== true && payload.dispatch?.available === true;
      const models = Array.isArray(worker?.models) ? worker.models.filter((v: unknown) => v && typeof v === 'object').map((v: { id: string; available?: boolean }) => ({ id: v.id, label: v.id === 'birefnet' ? 'BiRefNet' : v.id === 'fallback' ? '基础模型' : v.id, available: v.available === true })) : [];
      const message = !key ? '抠图服务已连接，但当前账户尚未绑定业务授权，不能提交任务；请联系管理员完成接入'
        : !authorized ? '当前账户的抠图业务授权尚未通过验证，不能提交任务；请联系管理员检查接入'
        : worker?.paused ? '抠图计算端已暂停，可查看历史；恢复后可提交任务'
        : !worker?.online ? '抠图计算端离线，可查看历史；上线后可提交任务'
        : !payload.dispatch?.available ? '抠图队列暂不可用，可查看历史；恢复后可提交任务' : '抠图服务已就绪';
      return json({ success: true, api_version: 'v1', limits: payload.limits, models,
        worker: { online: worker?.online === true, busy: worker?.busy === true, paused: worker?.paused === true, device: worker?.device },
        dispatch: { available: payload.dispatch?.available === true, configured: payload.dispatch?.configured === true },
        integration: { configured: Boolean(key), authorized, ready, message } });
    }
    if (!key) return failure('CUTOUT_IDENTITY_NOT_CONFIGURED', '当前账户尚未绑定抠图业务授权，任务没有提交；请联系管理员完成接入', 503);
    const target = new URL(targetPath, base), incoming = new URL(request.url);
    for (const name of ['limit', 'offset']) { const value = incoming.searchParams.get(name); if (value !== null && targetPath.endsWith('/jobs/history')) target.searchParams.set(name, value); }
    const headers = new Headers({ 'X-API-Key': key });
    // 白名单避免外传SD2的cookie或客户端提供的认证身份。
    for (const name of ['content-type', 'idempotency-key']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
    const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers };
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (targetPath === '/api/v1/jobs' && request.method === 'POST') {
        const input = await request.json().catch(() => null);
        if (!input || typeof input.asset_id !== 'string' || !/^[\w-]{1,128}$/.test(input.asset_id) || !KINDS.has(input.kind) || !input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters) || Object.keys(input).some(k => !['asset_id', 'kind', 'parameters'].includes(k))) return failure('INVALID_JOB', '任务内容无效，请检查原图与处理方式后重试', 400);
        if (!/^[\w-]{16,128}$/.test(headers.get('idempotency-key') || '')) return failure('INVALID_RETRY_KEY', '提交标识无效，请重新开始这次处理', 400);
        init.body = JSON.stringify(input);
      } else { init.body = request.body; init.duplex = 'half'; }
    }
    const response = await fetchUpstream(fetcher, target.toString(), init, 45_000);
    if (!response.ok) return upstreamFailure(response, !['GET', 'HEAD'].includes(request.method));
    if (response.headers.get('content-type')?.includes('json')) return json(rewriteCutoutUrls(await response.json(), base), response.status);
    const responseHeaders = new Headers(PRIVATE);
    for (const name of ['content-type', 'content-disposition', 'content-length']) { const v = response.headers.get(name); if (v) responseHeaders.set(name, v); }
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return json({ success: false, error: 'CUTOUT_SERVICE_UNAVAILABLE', message: '抠图服务连接中断。原图与已有结果保留；已提交的任务请重新查询，不要重复提交', submission_made: null }, 502);
  }
}
