import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  createFeishuExchangePermitStore,
  proxySd2CanvasRequest,
} from '../lib/ultimate-canvas-sd2-proxy.mjs';

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

async function main() {
  const upstreamRequests: Array<{
    body: string;
    headers: http.IncomingHttpHeaders;
    method?: string;
    url?: string;
  }> = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    upstreamRequests.push({
      body: Buffer.concat(chunks).toString('utf8'),
      headers: request.headers,
      method: request.method,
      url: request.url,
    });

    if (request.url === '/api/auth/login' && request.method === 'POST') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'session=live-token; HttpOnly; SameSite=Lax',
      });
      response.end('{"ok":true}');
      return;
    }

    if (request.url === '/api/auth/feishu/login-by-code' && request.method === 'POST') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'session=feishu-session; HttpOnly; SameSite=Lax',
      });
      response.end('{"ok":true}');
      return;
    }

    if (request.url === '/api/tools/ultimate-canvas/documents?project_id=project-1' && request.method === 'POST') {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"saved":true}');
      return;
    }

    if (request.url === '/api/projects' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"projects":[]}');
      return;
    }

    if (request.url === '/api/approvals' && request.method === 'POST') {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"approval":{"id":"approval-1"}}');
      return;
    }

    if (request.url === '/uploads/live.mp4') {
      response.writeHead(206, {
        'accept-ranges': 'bytes',
        'content-range': 'bytes 0-3/4',
        'content-type': 'video/mp4',
      });
      response.end(Buffer.from([1, 2, 3, 4]));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
  });
  const upstreamPort = await listen(upstream);

  let currentTime = 0;
  const permitStore = createFeishuExchangePermitStore({
    maxAgeMs: 1_000,
    now: () => currentTime,
  });
  let proxyOrigin = '';
  const proxy = http.createServer((request, response) => {
    void proxySd2CanvasRequest(request, response, {
      origin: `http://127.0.0.1:${upstreamPort}`,
      localOrigin: proxyOrigin,
      consumeFeishuExchangePermit: permitStore.consume,
    });
  });
  const proxyPort = await listen(proxy);
  proxyOrigin = `http://127.0.0.1:${proxyPort}`;

  async function exchange(options: {
    contentType?: string;
    host?: string;
    method?: string;
    origin?: string;
    permit?: string;
  } = {}) {
    const headers: Record<string, string> = {
      'content-type': options.contentType ?? 'application/json',
      origin: options.origin ?? proxyOrigin,
    };
    if (options.host) headers.host = options.host;
    if (options.permit) headers['x-sd2-feishu-exchange-permit'] = options.permit;
    const method = options.method ?? 'POST';
    return new Promise<{
      headers: http.IncomingHttpHeaders;
      json: () => unknown;
      status: number;
    }>((resolve, reject) => {
      const request = http.request(`${proxyOrigin}/api/auth/feishu/login-by-code`, {
        method,
        headers,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            headers: response.headers,
            json: () => JSON.parse(body),
            status: response.statusCode || 0,
          });
        });
      });
      request.once('error', reject);
      if (method === 'POST') request.write('{"code":"synthetic-code"}');
      request.end();
    });
  }

  function feishuExchangeRequestCount() {
    return upstreamRequests.filter((request) => request.url === '/api/auth/feishu/login-by-code').length;
  }

  try {
    let exchangeCount = feishuExchangeRequestCount();
    const missingPermit = await exchange();
    assert.equal(missingPermit.status, 403);
    assert.deepEqual(missingPermit.json(), { error: 'Forbidden' });
    assert.equal(feishuExchangeRequestCount(), exchangeCount);

    const wrongPermit = await exchange({ permit: 'w'.repeat(43) });
    assert.equal(wrongPermit.status, 403);
    assert.equal(feishuExchangeRequestCount(), exchangeCount);

    const expiredPermit = permitStore.issue();
    currentTime += 1_001;
    const expired = await exchange({ permit: expiredPermit });
    assert.equal(expired.status, 403);
    assert.equal(feishuExchangeRequestCount(), exchangeCount);

    const validPermit = permitStore.issue();
    const wrongHost = await exchange({
      host: `localhost:${proxyPort}`,
      permit: validPermit,
    });
    assert.equal(wrongHost.status, 403);
    assert.equal(feishuExchangeRequestCount(), exchangeCount);

    const wrongOrigin = await exchange({ origin: 'https://attacker.example', permit: validPermit });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(feishuExchangeRequestCount(), exchangeCount);

    const missingOrigin = await exchange({ origin: '', permit: validPermit });
    assert.equal(missingOrigin.status, 403);
    assert.equal(feishuExchangeRequestCount(), exchangeCount);

    const textPlain = await exchange({ contentType: 'text/plain', permit: validPermit });
    assert.equal(textPlain.status, 403);
    assert.equal(feishuExchangeRequestCount(), exchangeCount);

    const wrongMethod = await exchange({ method: 'GET', permit: validPermit });
    assert.equal(wrongMethod.status, 403);
    assert.equal(feishuExchangeRequestCount(), exchangeCount);

    const accepted = await exchange({ permit: validPermit });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.headers['set-cookie'], ['session=feishu-session; HttpOnly; SameSite=Lax']);
    exchangeCount += 1;
    assert.equal(feishuExchangeRequestCount(), exchangeCount);
    const acceptedRequest = upstreamRequests.findLast(
      (request) => request.url === '/api/auth/feishu/login-by-code',
    );
    assert(acceptedRequest);
    assert.equal(acceptedRequest.headers['x-sd2-feishu-exchange-permit'], undefined);

    const replayed = await exchange({ permit: validPermit });
    assert.equal(replayed.status, 403);
    assert.equal(feishuExchangeRequestCount(), exchangeCount);

    const passwordLoginRequestCount = upstreamRequests.filter(
      (request) => request.url === '/api/auth/login',
    ).length;
    const login = await fetch(`${proxyOrigin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'ordinary-user', password: 'not-a-secret' }),
    });
    assert.equal(login.status, 404);
    assert.deepEqual(await login.json(), { error: 'Not found' });
    assert.equal(
      upstreamRequests.filter((request) => request.url === '/api/auth/login').length,
      passwordLoginRequestCount,
    );

    const save = await fetch(`${proxyOrigin}/api/tools/ultimate-canvas/documents?project_id=project-1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'session=live-token',
        origin: proxyOrigin,
        referer: `${proxyOrigin}/tools/ultimate-canvas/index.html`,
      },
      body: JSON.stringify({ document: { nodes: [] } }),
    });
    assert.equal(save.status, 201);
    assert.deepEqual(await save.json(), { saved: true });

    const saveRequest = upstreamRequests.at(-1);
    assert(saveRequest);
    assert.equal(saveRequest.method, 'POST');
    assert.equal(saveRequest.url, '/api/tools/ultimate-canvas/documents?project_id=project-1');
    assert.equal(saveRequest.body, JSON.stringify({ document: { nodes: [] } }));
    assert.equal(saveRequest.headers.cookie, 'session=live-token');
    assert.equal(saveRequest.headers.host, `127.0.0.1:${upstreamPort}`);
    assert.equal(saveRequest.headers.origin, `http://127.0.0.1:${upstreamPort}`);
    assert.equal(saveRequest.headers.referer, `http://127.0.0.1:${upstreamPort}/tools/ultimate-canvas/index.html`);

    const media = await fetch(`${proxyOrigin}/uploads/live.mp4`, {
      headers: { range: 'bytes=0-3' },
    });
    assert.equal(media.status, 206);
    assert.equal(media.headers.get('content-range'), 'bytes 0-3/4');
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), Buffer.from([1, 2, 3, 4]));

    const projects = await fetch(`${proxyOrigin}/api/projects`);
    assert.equal(projects.status, 200);
    assert.deepEqual(await projects.json(), { projects: [] });
    assert.equal(upstreamRequests.at(-1)?.url, '/api/projects');

    const approvals = await fetch(`${proxyOrigin}/api/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'ratio_change' }),
    });
    assert.equal(approvals.status, 201);
    assert.deepEqual(await approvals.json(), { approval: { id: 'approval-1' } });
    assert.equal(upstreamRequests.at(-1)?.url, '/api/approvals');

    const requestsBeforeBlockedPath = upstreamRequests.length;
    const blocked = await fetch(`${proxyOrigin}/api/admin/settings`);
    assert.equal(blocked.status, 404);
    assert.equal(upstreamRequests.length, requestsBeforeBlockedPath);
  } finally {
    await close(proxy);
    await close(upstream);
  }

  console.log('ultimate-canvas-sd2-live-proxy-smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
