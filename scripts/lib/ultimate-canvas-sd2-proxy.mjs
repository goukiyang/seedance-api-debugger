import http from 'node:http';
import https from 'node:https';

export const SD2_CANVAS_PROXY_PATHS = Object.freeze([
  '/api/auth/login',
  '/api/auth/me',
  '/api/auth/feishu/login-by-code',
  '/api/tools/ultimate-canvas',
  '/api/projects',
  '/api/video-cards',
  '/api/assets',
  '/api/tasks',
  '/api/video',
  '/api/reference-albums',
  '/api/approvals',
  '/uploads',
]);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function headersWithoutHopByHop(headers) {
  const connectionHeaders = String(headers.connection || '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  const omittedHeaders = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders]);

  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => value !== undefined && !omittedHeaders.has(name.toLowerCase())),
  );
}

function rewriteReferer(referer, target) {
  try {
    const source = new URL(referer);
    return `${target.origin}${source.pathname}${source.search}`;
  } catch {
    return target.origin;
  }
}

export function isAllowedSd2CanvasPath(pathname) {
  return pathname === '/api/auth/login'
    || pathname === '/api/auth/me'
    || pathname === '/api/auth/feishu/login-by-code'
    || SD2_CANVAS_PROXY_PATHS.slice(3).some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function proxySd2CanvasRequest(request, response, options) {
  const origin = new URL(options.origin);
  const incomingUrl = new URL(request.url || '/', 'http://localhost');

  if (!isAllowedSd2CanvasPath(incomingUrl.pathname)) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  const target = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, origin);
  const headers = headersWithoutHopByHop(request.headers);
  headers.host = target.host;
  if (headers.origin) headers.origin = target.origin;
  if (headers.referer) headers.referer = rewriteReferer(headers.referer, target);

  const transport = target.protocol === 'https:' ? https : http;
  let upstreamResponseStarted = false;
  const upstreamRequest = transport.request(target, {
    headers,
    method: request.method,
  }, (upstreamResponse) => {
    upstreamResponseStarted = true;
    response.writeHead(
      upstreamResponse.statusCode || 502,
      upstreamResponse.statusMessage,
      headersWithoutHopByHop(upstreamResponse.headers),
    );
    upstreamResponse.pipe(response);
  });

  upstreamRequest.once('error', () => {
    if (upstreamResponseStarted || response.headersSent) {
      response.destroy();
      return;
    }
    sendJson(response, 502, { error: 'SD2 proxy unavailable' });
  });

  request.pipe(upstreamRequest);
}
