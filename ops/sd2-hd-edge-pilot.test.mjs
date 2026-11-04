import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import sharp from 'sharp';
import { createHdEdgePilot } from './sd2-hd-edge-pilot.mjs';

test('HD edge pilot preserves the current combined GET and fails closed', { timeout: 15000 }, async t => {
  const width = 3840, height = 2160, bytes = 3486591;
  const avif = await sharp({ create: { width, height, channels: 3, background: '#756b8e' } })
    .avif({ effort: 0 }).toBuffer();
  const padding = Buffer.alloc(bytes - avif.length, 0xa7);
  padding.writeUInt32BE(padding.length);
  padding.write('free', 4);
  const image = Buffer.concat([avif, padding]);
  const sha256 = createHash('sha256').update(image).digest('hex');
  const sourceVersion = 'fixture-source-v1', representationVersion = 'hd-representation-v1:' + 'b'.repeat(64);
  const objectEtag = '"fixed-object-etag"', originEtag = 'W/"current-origin-etag"';
  const template = '/api/image-studio/assets/asset1', works = '/api/works/work1/media';
  const templateOpen = template + '?hd-description=1', workOpen = works + '?variant=hd-description&version=work-v1';
  const appOrigin = 'https://origin.example', siteOrigin = 'https://pilot.example', objectOrigin = 'https://cos.example';
  const objectPath = '/pilot/' + sha256 + '.avif';
  const config = { siteOrigin, appOrigin, objectOrigin, entries: [
    { route: 'template', id: 'asset1' },
    { route: 'works', id: 'work1', workVersion: 'work-v1' },
  ].map(entry => ({ ...entry, sourceVersion, representationVersion, width, height, bytes, sha256,
    format: 'avif', objectEtag, objectUrl: objectOrigin + objectPath + '?signature=synthetic-only' })) };
  const seen = [];
  let revoked = false, originStatus = 200, objectStatus = 200, holdTail, releaseTail;
  const originHeaders = { 'content-type': 'image/avif', 'content-length': String(bytes), 'cache-control': 'private, no-store',
    'x-image-source-version': sourceVersion, 'x-image-representation-version': representationVersion, etag: originEtag };
  const objectHeaders = { 'content-type': 'image/avif', 'content-length': String(bytes), etag: objectEtag,
    'x-cos-meta-sha256': sha256, 'x-cos-request-id': 'internal-marker' };
  const server = createServer((req, res) => {
    const call = { method: req.method, url: req.url, headers: req.headers };
    seen.push(call);
    if (req.url.startsWith('/app/')) {
      if (req.headers.cookie !== 'session=owner' || revoked) return res.writeHead(403).end();
      if (originStatus !== 200) return res.writeHead(originStatus, { Location: objectOrigin + '/never-follow' }).end();
      return res.writeHead(200, originHeaders).end();
    }
    if (objectStatus !== 200) return res.writeHead(objectStatus, { Location: appOrigin + '/never-follow' }).end();
    res.writeHead(200, objectHeaders);
    if (!holdTail) return res.end(image);
    res.write(image.subarray(0, 65536));
    const sendTail = () => res.end(image.subarray(65536));
    holdTail.then(sendTail);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { releaseTail?.(); server.closeAllConnections(); server.close(); });
  const loopback = 'http://127.0.0.1:' + server.address().port;
  const call = (target, options) => {
    const url = new URL(target);
    assert.ok([appOrigin, objectOrigin].includes(url.origin));
    assert.equal(options.redirect, 'manual');
    return fetch(loopback + (url.origin === appOrigin ? '/app' : '/object') + url.pathname + url.search, options);
  };
  const pilot = createHdEdgePilot(config, call);
  const open = (path, options = {}) => pilot(new Request(siteOrigin + path, { method: options.method || 'GET',
    headers: { 'X-Image-Accept': 'hd-open-v1', ...(options.anonymous ? {} : { Cookie: 'session=owner' }), ...options.headers } }));

  await t.test('one browser GET yields a streamed full-size AVIF with existing descriptor on both routes', async () => {
    for (const [path, expectedHead] of [[templateOpen, '/app' + template + '?hd=1'],
      [workOpen, '/app' + works + '?variant=hd&version=work-v1']]) {
      seen.length = 0;
      holdTail = new Promise(resolve => { releaseTail = resolve; });
      const response = await open(path);
      assert.equal(response.status, 200);
      assert.deepEqual(seen.map(row => [row.method, row.url]), [
        ['HEAD', expectedHead], ['GET', '/object' + objectPath + '?signature=synthetic-only'],
      ]);
      assert.equal(seen[0].headers.cookie, 'session=owner');
      assert.match(seen[0].headers['cache-control'], /no-cache/);
      assert.equal(seen[1].headers.cookie, undefined);
      assert.equal(seen[1].headers['if-match'], objectEtag);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('content-type'), 'image/avif');
      assert.equal(response.headers.get('content-length'), String(bytes));
      assert.equal(response.headers.get('x-image-source-version'), sourceVersion);
      assert.equal(response.headers.get('x-image-representation-version'), representationVersion);
      assert.equal(response.headers.get('etag'), originEtag);
      assert.match(response.headers.get('server-timing'), /^hd_edge_auth;dur=\d+, hd_edge_object_headers;dur=\d+$/);
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.get('x-cos-request-id'), null);
      assert.deepEqual(JSON.parse(response.headers.get('x-image-hd-description')), {
        policy: 'hd-f-v1', status: 'ready', sourceVersion, representationVersion, width, height, bytes,
        format: 'avif', mime: 'image/avif', original: false,
      });
      releaseTail();
      holdTail = null;
      const received = Buffer.from(await response.arrayBuffer());
      assert.equal(received.length, bytes);
      assert.equal(createHash('sha256').update(received).digest('hex'), sha256);
      const size = await sharp(received).metadata();
      assert.deepEqual([size.width, size.height], [width, height]);
    }
  });

  await t.test('revocation, anonymous reads, redirects and unavailable auth never reach object bytes', async () => {
    seen.length = 0;
    revoked = true;
    assert.equal((await open(templateOpen)).status, 403);
    assert.deepEqual(seen.map(x => x.method), ['HEAD']);
    revoked = false;
    seen.length = 0;
    assert.equal((await open(workOpen, { anonymous: true })).status, 401);
    assert.equal(seen.length, 0);
    for (const [status, expected] of [[401, 401], [404, 404], [302, 503], [503, 503]]) {
      seen.length = 0;
      originStatus = status;
      const response = await open(workOpen);
      assert.equal(response.status, expected);
      assert.equal(response.headers.get('location'), null);
      assert.deepEqual(seen.map(x => x.method), ['HEAD']);
    }
    originStatus = 200;
    originHeaders['cache-control'] = 'public, max-age=60';
    seen.length = 0;
    assert.equal((await open(templateOpen)).status, 503);
    assert.deepEqual(seen.map(x => x.method), ['HEAD']);
    originHeaders['cache-control'] = 'private, no-store';
  });

  await t.test('pending or changed representation delegates to the current application', async () => {
    seen.length = 0;
    originStatus = 409;
    assert.equal(await open(templateOpen), undefined);
    assert.deepEqual(seen.map(x => x.method), ['HEAD']);
    originStatus = 200;
    seen.length = 0;
    originHeaders['x-image-representation-version'] = 'different-version';
    assert.equal(await open(workOpen), undefined);
    assert.deepEqual(seen.map(x => x.method), ['HEAD']);
    originHeaders['x-image-representation-version'] = representationVersion;
  });

  await t.test('private bytes with a wrong fingerprint or redirect delegate without serving the object', async () => {
    seen.length = 0;
    objectHeaders['x-cos-meta-sha256'] = 'different';
    assert.equal(await open(templateOpen), undefined);
    assert.deepEqual(seen.map(x => x.method), ['HEAD', 'GET']);
    objectHeaders['x-cos-meta-sha256'] = sha256;
    seen.length = 0;
    objectStatus = 302;
    assert.equal(await open(workOpen), undefined);
    assert.deepEqual(seen.map(x => x.method), ['HEAD', 'GET']);
    objectStatus = 200;
  });

  await t.test('legacy, prefetch, Range, conditional, comparison, stale works and unmapped requests pass through', async () => {
    seen.length = 0;
    assert.equal(await open(templateOpen, { headers: { 'X-Image-Accept': 'legacy' } }), undefined);
    assert.equal(await open(templateOpen, { headers: { 'X-Image-Read-Intent': 'prefetch' } }), undefined);
    assert.equal(await open(templateOpen, { headers: { Range: 'bytes=0-1' } }), undefined);
    assert.equal(await open(templateOpen, { headers: { 'If-None-Match': '*' } }), undefined);
    assert.equal(await open(templateOpen + '&comparison-version=abc'), undefined);
    assert.equal(await open(workOpen.replace('work-v1', 'old')), undefined);
    assert.equal(await open(templateOpen, { method: 'HEAD' }), undefined);
    assert.equal(await open(templateOpen.replace('asset1', 'unknown')), undefined);
    assert.equal(seen.length, 0);
  });

  await t.test('startup rejects recursive authorization and untrusted object hosts', () => {
    assert.throws(() => createHdEdgePilot({ ...config, appOrigin: siteOrigin }, call), /distinct/);
    const entries = [{ ...config.entries[0], objectUrl: config.entries[0].objectUrl.replace(objectOrigin, 'https://other.example') }];
    assert.throws(() => createHdEdgePilot({ ...config, entries }, call), /invalid pilot entry/);
  });
});
