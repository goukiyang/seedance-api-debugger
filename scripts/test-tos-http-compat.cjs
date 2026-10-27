'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { TosClient } = require('@volcengine/tos-sdk');

async function main() {
  const proxy = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(https?|all)_proxy$/i.test(key)));
  for (const key of Object.keys(proxy)) delete process.env[key];
  const requests = [];
  const bytes = Buffer.from('synthetic-storage-contract');
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks), signed: /^TOS4-HMAC-SHA256 /.test(request.headers.authorization || '') });
    response.setHeader('x-tos-request-id', 'synthetic-request');
    response.setHeader('ETag', '"synthetic-etag"');
    if (request.url.includes('denied')) {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ Code: 'AccessDenied', Message: 'synthetic refusal' }));
    } else if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
      response.end(bytes);
    } else { response.writeHead(200); response.end(); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new TosClient({ accessKeyId: 'synthetic-key-id', accessKeySecret: 'synthetic-secret', region: 'cn-beijing',
      endpoint: `127.0.0.1:${server.address().port}`, secure: false, maxRetryCount: 0, requestTimeout: 3000 });
    await client.putObject({ bucket: 'synthetic-bucket', key: 'fixture.bin', body: bytes, contentType: 'application/octet-stream' });
    const result = await client.getObjectV2({ bucket: 'synthetic-bucket', key: 'fixture.bin', dataType: 'buffer' });
    assert.deepEqual(result.data.content, bytes);
    await assert.rejects(() => client.getObjectV2({ bucket: 'synthetic-bucket', key: 'denied', dataType: 'buffer' }), error => error.statusCode === 403);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => request.signed && request.url.startsWith('/synthetic-bucket/')));
    assert.deepEqual(requests[0].body, bytes);
    console.log('PASS TOS SDK with patched Axios: signed PUT/GET bytes and 403 semantics');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    Object.assign(process.env, proxy);
  }
}
main().catch(error => { console.error(error.name, error.message); process.exitCode = 1; });
