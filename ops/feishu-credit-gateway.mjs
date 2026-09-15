import { createServer } from 'node:http';
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const source = 'sd2_credit_requests_v1';
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function timestampSeconds(text) {
  if (/^\d{10}$/.test(text)) return Number(text);
  if (/^\d{13}$/.test(text)) return Number(text) / 1000;
  const go = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?\s+([+-]\d{4})\s+[A-Za-z]+(?:\s+m=[+-]\d+(?:\.\d+)?)?$/);
  return go ? Date.parse(`${go[1]}T${go[2]}${go[3].slice(0, 3)}:${go[3].slice(3)}`) / 1000 : NaN;
}

export function routePayload(raw, headers, env, now = Date.now()) {
  let payload;
  try {
    payload = JSON.parse(raw);
    if (typeof payload.encrypt === 'string') {
      const bytes = Buffer.from(payload.encrypt, 'base64');
      const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(env.FEISHU_EVENT_ENCRYPT_KEY || '').digest(), bytes.subarray(0, 16));
      payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8'));
    }
  } catch { return { kind: 'legacy', body: raw }; }
  if (payload?.event?.action?.value?.source !== source) return { kind: 'legacy', body: raw };
  const timestamp = String(headers['x-lark-request-timestamp'] || '');
  const nonce = String(headers['x-lark-request-nonce'] || '');
  const seconds = timestampSeconds(timestamp);
  const key = env.FEISHU_EVENT_ENCRYPT_KEY;
  const token = env.FEISHU_VERIFICATION_TOKEN || env.ARTREVIEW_FEISHU_VERIFICATION_TOKEN;
  if (!key || !token || !env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !Number.isFinite(seconds)
    || !nonce || nonce.length > 256 || Math.abs(now / 1000 - seconds) > 300
    || !equal(String(headers['x-lark-signature'] || ''), createHash('sha256').update(timestamp + nonce + key + raw).digest('hex'))
    || payload.header?.app_id !== env.FEISHU_APP_ID || payload.header?.event_type !== 'card.action.trigger'
    || !equal(payload.header?.token, token)) throw new Error('invalid_credit_callback');
  // SD2 verifies the signed app/tenant/operator and its own request state again.
  const body = JSON.stringify({ header: { app_id: payload.header.app_id, tenant_key: payload.header.tenant_key, event_type: payload.header.event_type }, event: payload.event });
  const time = String(now);
  return { kind: 'credit', body, headers: {
    'x-sd2-credit-time': time,
    'x-sd2-credit-signature': createHmac('sha256', env.FEISHU_APP_SECRET).update(`sd2-credit-relay-v1\n${time}\n${body}`).digest('hex'),
  } };
}

export function createGateway(env = process.env, fetcher = fetch) {
  return createServer(async (request, response) => {
    const json = (code, body) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.url === '/health' && request.method === 'GET') return json(200, { ok: true, service: 'sd2-credit-gateway',
      configured: Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_EVENT_ENCRYPT_KEY
        && (env.FEISHU_VERIFICATION_TOKEN || env.ARTREVIEW_FEISHU_VERIFICATION_TOKEN)) });
    if (request.url !== '/webhooks/feishu/card-actions' || request.method !== 'POST') return json(404, { error: 'not_found' });
    try {
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1048576) return json(413, { error: 'too_large' });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const routed = routePayload(raw, request.headers, env);
      const headers = { 'Content-Type': 'application/json' };
      if (routed.kind === 'legacy') {
        for (const key of ['x-lark-request-timestamp', 'x-lark-request-nonce', 'x-lark-signature']) {
          if (typeof request.headers[key] === 'string') headers[key] = request.headers[key];
        }
      } else Object.assign(headers, routed.headers);
      const upstream = await fetcher(routed.kind === 'credit' ? 'http://127.0.0.1:3302/api/feishu/credit-actions'
        : 'http://127.0.0.1:8788/webhooks/feishu/card-actions', {
        method: 'POST', headers, body: routed.body, signal: AbortSignal.timeout(routed.kind === 'credit' ? 2500 : 25000),
      });
      const body = await upstream.text();
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
      response.end(body);
    } catch {
      json(502, { toast: { type: 'error', content: '暂未完成，请稍后重试或在网站查看结果' } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET || !process.env.FEISHU_EVENT_ENCRYPT_KEY
    || !(process.env.FEISHU_VERIFICATION_TOKEN || process.env.ARTREVIEW_FEISHU_VERIFICATION_TOKEN)) throw new Error('gateway_configuration_missing');
  createGateway().listen(8790, '127.0.0.1');
}
