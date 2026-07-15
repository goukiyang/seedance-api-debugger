import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { proxySd2CanvasRequest } from './lib/ultimate-canvas-sd2-proxy.mjs';

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

  const proxy = http.createServer((request, response) => {
    void proxySd2CanvasRequest(request, response, {
      origin: `http://127.0.0.1:${upstreamPort}`,
    });
  });
  const proxyPort = await listen(proxy);
  const proxyOrigin = `http://127.0.0.1:${proxyPort}`;

  try {
    const login = await fetch(`${proxyOrigin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'ordinary-user', password: 'not-a-secret' }),
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('set-cookie'), 'session=live-token; HttpOnly; SameSite=Lax');

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
