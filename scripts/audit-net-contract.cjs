const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const deps = createRequire(path.resolve(process.env.AUD_NODE_MODULES || 'node_modules', 'package.json'));
const ts = deps('typescript');
const root = process.cwd();
process.exitCode = 1;
const mocks = new Map();
const cache = new Map();
function load(name, expose = '') {
  const file = path.resolve(root, name);
  if (mocks.has(name)) return mocks.get(name);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const text = fs.readFileSync(file, 'utf8') + (expose ? `\nexport { ${expose} };` : '');
  const source = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const requireLocal = id => {
    if (mocks.has(id)) return mocks.get(id);
    if (id.startsWith('@/')) return load(`src/${id.slice(2)}.ts`);
    if (id.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(file), `${id}.ts`)));
    if (id === 'ipaddr.js') return require(path.join(root, 'node_modules/ipaddr.js'));
    return deps(id);
  };
  new Function('require', 'module', 'exports', '__filename', '__dirname', source)(requireLocal, module, module.exports, file, path.dirname(file));
  return module.exports;
}
function loadFunctions(file, names, bindings) {
  const tree = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const source = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(tree)).join('\n');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(bindings), `${compiled}\nreturn { ${names.join(',')} };`)(...Object.values(bindings));
}
let answers = [{ address: '93.184.216.34', family: 4 }];
let requests = [];
let replies = [];
let lookupCalls = 0;
mocks.set('node:dns/promises', { lookup: async () => { lookupCalls++; return answers; } });
function request(url, options, callback) {
  const req = new EventEmitter();
  req.destroy = error => { if (error) req.emit('error', error); req.emit('close'); };
  options.signal.addEventListener('abort', () => req.destroy(new Error('private upstream detail')), { once: true });
  req.end = body => {
    requests.push({ url: String(url), options, body });
    if (options.lookup) options.lookup(url.hostname, {}, (error, address, family) => {
      assert.ifError(error); requests.at(-1).pinned = { address, family };
    });
    const reply = replies.shift() || { status: 200, chunks: ['synthetic'] };
    if (reply.hang) {
      return;
    }
    queueMicrotask(() => {
      const response = reply.stall ? new Readable({ read() {} }) : Readable.from((reply.chunks || []).map(chunk => Buffer.from(chunk)));
      response.statusCode = reply.status || 200;
      response.headers = reply.headers || {};
      response.setTimeout = () => response;
      response.on('error', () => {});
      callback(response);
    });
  };
  req.setTimeout = () => req;
  return req;
}
mocks.set('node:http', { request }); mocks.set('node:https', { request });
const tests = [];
const test = (name, run) => tests.push({ name, run });
test('thumbnail output accepts the configured video root symlink but refuses nested escapes', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aud-net-thumbnail-'));
  try {
    await fsp.mkdir(path.join(dir, 'public'));
    await fsp.mkdir(path.join(dir, 'data/videos/thumbnails'), { recursive: true });
    await fsp.symlink(path.join(dir, 'data/videos'), path.join(dir, 'public/videos'));
    const { resolveInsideSync } = load('src/lib/fs/resolve-inside.ts');
    const { thumbnailFilePath } = loadFunctions('src/lib/video/thumbnail.ts', ['thumbnailFilePath'], {
      exports: {}, PUBLIC_VIDEO_ROOT: path.join(dir, 'public'), path, resolveInsideSync, isSafeTaskId: value => /^[a-z0-9-]+$/.test(value),
    });
    assert.equal(thumbnailFilePath('synthetic-task'), path.join(await fsp.realpath(dir), 'data/videos/thumbnails/synthetic-task.jpg'));
    await fsp.symlink(path.join(dir, 'outside.jpg'), path.join(dir, 'data/videos/thumbnails/escape.jpg'));
    assert.throws(() => thumbnailFilePath('escape'), /INVALID_LOCAL_PATH/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
test('actual public URL helper rejects mapped IPv6 and reserved CIDRs', () => {
  const { isPrivateNetworkHost, isPublicHttpUrl } = load('src/lib/media/public-url.ts');
  for (const host of ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '[fd00::1]', '100.64.0.1',
    '169.254.169.254', '0.1.2.3', '192.0.2.1', '198.18.0.1', '224.0.0.1', '2001:db8::1', 'fe80::1', 'localhost.']) {
    assert.equal(isPrivateNetworkHost(host), true, host);
  }
  for (const value of ['http://example.org:8080/x', 'ftp://example.org/x', 'https://user:pass@example.org/x', 'http://2130706433/x', 'http://0x7f000001/x']) assert.equal(isPublicHttpUrl(value), false, value);
  assert.equal(isPublicHttpUrl('https://example.org/x'), true);
});
test('actual feedback PDF refuses traversal and symlink escape', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aud-net-pdf-'));
  const cwd = process.cwd();
  try {
    await fsp.mkdir(path.join(dir, 'public/uploads'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'secret.png'), 'synthetic private file');
    await fsp.symlink(path.join(dir, 'secret.png'), path.join(dir, 'public/uploads/escape.png'));
    process.chdir(dir);
    const { imageBufferFromUrl } = load('src/lib/feedback/pdf.ts', 'imageBufferFromUrl');
    for (const url of ['/../secret.png', '/%2e%2e/secret.png', '/uploads/escape.png', '//example.org/image.png']) assert.equal(await imageBufferFromUrl(url), null, url);
  } finally { process.chdir(cwd); await fsp.rm(dir, { force: true, recursive: true }); }
});
test('safe transport validates all answers, pins DNS, ports, methods and redirects', async () => {
  const { safeFetch, validatePublicUrl } = load('src/lib/net/safe-fetch.ts');
  const options = { maxBytes: 32, timeoutMs: 1000 };
  requests = []; lookupCalls = 0;
  for (const address of ['10.0.0.1', '::ffff:127.0.0.1', 'fd00::1']) {
    answers = [{ address: '93.184.216.34', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }];
    await assert.rejects(validatePublicUrl('https://synthetic.invalid/x'), error => error.code === 'ADDRESS_NOT_ALLOWED');
  }
  assert.equal(requests.length, 0);
  answers = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  for (const url of ['file:///tmp/synthetic', 'http://synthetic.invalid:8080', 'https://[::ffff:127.0.0.1]/']) await assert.rejects(safeFetch(url, options));
  replies = [{ chunks: ['ok'] }];
  const response = await safeFetch('https://synthetic.invalid/x', { ...options, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(requests.at(-1).pinned, answers[0]);
  assert.equal(requests.at(-1).options.method, 'POST'); assert.equal(requests.at(-1).body, '{}');
  replies = [{ status: 302, headers: { location: 'http://127.0.0.1/metadata' } }];
  await assert.rejects(safeFetch('http://synthetic.invalid', { ...options, allowRedirects: true }));
  replies = [{ status: 302, headers: { location: '/next' } }];
  await assert.rejects(safeFetch('https://synthetic.invalid', options));
  const before = lookupCalls;
  replies = Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/next' } }));
  await assert.rejects(safeFetch('https://synthetic.invalid', { ...options, allowRedirects: true }));
  assert.equal(lookupCalls - before, 4, 'initial hop plus max three independently validated redirects');
});
test('safe transport caps chunked and declared bodies and keeps deadline through body', async () => {
  const { safeFetch } = load('src/lib/net/safe-fetch.ts');
  const options = { maxBytes: 3, timeoutMs: 40 };
  replies = [{ headers: { 'content-length': '1000' } }];
  await assert.rejects(safeFetch('https://synthetic.invalid', options), error => error.code === 'TOO_LARGE');
  replies = [{ chunks: ['12', '34'] }];
  const response = await safeFetch('https://synthetic.invalid', options);
  await assert.rejects(response.arrayBuffer(), error => error.code === 'TOO_LARGE');
  replies = [{ hang: true }];
  await assert.rejects(safeFetch('https://synthetic.invalid', options), error => error.code === 'TIMEOUT' && !error.message.includes('private upstream'));
  replies = [{ stall: true }];
  const stalled = await safeFetch('https://synthetic.invalid', options);
  await assert.rejects(stalled.arrayBuffer(), error => error.code === 'TIMEOUT');
});
test('resolveInside rejects absolute, traversal and existing/missing symlink escapes', async () => {
  const { resolveInside } = load('src/lib/fs/resolve-inside.ts');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aud-net-path-'));
  try {
    const base = path.join(dir, 'root'); await fsp.mkdir(base);
    await fsp.symlink(dir, path.join(base, 'out'));
    await fsp.symlink(path.join(dir, 'missing-outside'), path.join(base, 'dangling'));
    for (const value of ['../secret', '/etc/passwd', 'out/secret', 'out/not-yet-created/secret', 'dangling/new']) await assert.rejects(resolveInside(base, value));
    assert.equal(await resolveInside(base, 'new/file'), path.join(await fsp.realpath(base), 'new/file'));
  } finally { await fsp.rm(dir, { force: true, recursive: true }); }
});
test('probe downloads before local ffprobe and blocks protocols/type expansion', async () => {
  let invoked = false; let downloadedFile;
  mocks.set('node:child_process', { execFile: (bin, args, opts, done) => {
    invoked = true; downloadedFile = args.at(-1);
    assert.equal(bin, 'ffprobe'); assert.equal(args.includes('https://synthetic.invalid/video'), false);
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.equal(args[args.indexOf('-format_whitelist') + 1].includes('hls'), false);
    assert.equal(fs.readFileSync(downloadedFile, 'utf8'), 'synthetic media');
    done(null, { stdout: '{"streams":[{"codec_type":"video","width":640,"height":360}],"format":{"duration":"2"}}' });
  } });
  replies = [{ chunks: ['synthetic media'] }];
  const { probeRemoteMedia } = load('src/lib/media/probe-remote.ts');
  const metadata = await probeRemoteMedia('https://synthetic.invalid/video', 'video');
  assert.equal(invoked, true); assert.equal(metadata.streams[0].width, 640);
  assert.equal(fs.existsSync(downloadedFile), false, 'temporary source cleaned');
});
test('actual callback registration checks DNS and send revalidates without redirects', async () => {
  const { isPublicHttpUrl } = load('src/lib/media/public-url.ts');
  mocks.set('src/lib/assets/public-storage.ts', { isPubliclyReachableUrl: isPublicHttpUrl });
  mocks.set('src/lib/video/callback-auth.ts', { createVideoCallbackToken: () => 'synthetic-hmac' });
  const policy = load('src/lib/video/delivery-policy.ts');
  answers = [{ address: '10.0.0.1', family: 4 }];
  await assert.rejects(policy.validateExternalCallbackUrl('https://callback.invalid/done'));
  answers = [{ address: '93.184.216.34', family: 4 }];
  const before = requests.length;
  await policy.validateExternalCallbackUrl('https://callback.invalid/done');
  assert.equal(requests.length, before, 'registration does not send a request');
  const safe = load('src/lib/net/safe-fetch.ts');
  const updates = [];
  const { forwardExternalCallback } = loadFunctions('src/app/api/provider/seedance/callback/route.ts', ['nestedRecord', 'mergeForwardStatus', 'forwardExternalCallback'], {
    getExternalCallbackUrlFromParams: policy.getExternalCallbackUrlFromParams, safeFetch: safe.safeFetch,
    prisma: { videoTask: { update: async value => updates.push(value) } },
  });
  const input = { taskId: 'synthetic-task', paramsJson: JSON.stringify({ videoDeliveryCallback: { externalCallbackUrl: 'https://callback.invalid/done', authVersion: 2 } }), payload: { task_id: 'synthetic-task', local_status: 'succeeded' } };
  answers = [{ address: '::ffff:127.0.0.1', family: 6 }];
  const rejected = await forwardExternalCallback(input);
  assert.equal(rejected.forwarded, false); assert.equal(requests.length, before);
  assert.equal(rejected.error, 'external_callback_failed');
  answers = [{ address: '93.184.216.34', family: 4 }];
  replies = [{ status: 302, headers: { location: 'https://another.invalid/done' } }];
  const redirected = await forwardExternalCallback(input);
  assert.equal(redirected.forwarded, false); assert.equal(requests.length, before + 1);
  replies = [{ chunks: ['ack'] }];
  const delivered = await forwardExternalCallback(input);
  assert.equal(delivered.forwarded, true);
  assert.equal(requests.at(-1).options.method, 'POST');
  assert.equal(JSON.parse(requests.at(-1).body).sd2_task_id, 'synthetic-task');
  assert.equal(JSON.stringify(updates).includes('private upstream detail'), false);
});
test('image delivery keeps ETag, If-Range and completion with public transport', async () => {
  mocks.set('src/lib/media/sharp.ts', {});
  mocks.set('src/lib/assets/site-url.ts', { siteUploadPathFromUrl: () => null });
  const { openStudioImageStream } = load('src/lib/image-studio/media.ts');
  replies = [{ status: 206, headers: { 'content-length': '2', 'content-range': 'bytes 2-3/4', etag: '"same"' }, chunks: ['34'] }];
  const stream = await openStudioImageStream('https://synthetic.invalid/output', AbortSignal.timeout(1000), { phase: 'dns', attempt: 1, redirects: 0, receivedBytes: 0, elapsedMs: 0 },
    { Range: 'bytes=2-', 'If-Range': '"same"', 'Accept-Encoding': 'identity' });
  assert.equal(stream.statusCode, 206); assert.equal(stream.headers.etag, '"same"');
  assert.equal(requests.at(-1).options.headers['If-Range'], '"same"');
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), '34'); assert.equal(stream.complete, true);
});
test('failed upstream bodies are discarded and DNS is revalidated on each allowed hop', async () => {
  const { safeFetch } = load('src/lib/net/safe-fetch.ts');
  replies = [{ status: 403, chunks: ['private supplier body'] }];
  assert.equal(await (await safeFetch('https://synthetic.invalid/x', { maxBytes: 32, timeoutMs: 1000 })).text(), '');
  const before = lookupCalls;
  replies = [{ status: 302, headers: { location: '/two' } }, { status: 302, headers: { location: '/three' } }, { chunks: ['ok'] }];
  const response = await safeFetch('https://synthetic.invalid/one', { maxBytes: 32, timeoutMs: 1000, allowRedirects: true });
  assert.equal(await response.text(), 'ok'); assert.equal(lookupCalls - before, 3);
});
test('static guard rejects a new raw variable fetch and native HTTP transport', () => {
  const { inspect } = require('./check-audit-net.cjs');
  assert.equal(inspect('src/lib/new-resource.ts', 'async function read(url) { return fetch(url); }').length, 1);
  assert.equal(inspect('src/lib/new-resource.ts', 'https.get(url);').length, 1);
});
test('actual H3 resource handoff cannot bypass safeFetch via provider injection', async () => {
  const providerFetch = async () => { throw new Error('Resource download must not use provider fetch override'); };
  const uploads = [];
  mocks.set('src/lib/provider/h3.ts', { uploadH3ReferenceImage: async (body, options) => {
    assert.equal(options.fetchImpl, providerFetch); uploads.push(body);
    return { filename: `h3-${body.filename}`, sha256: 'synthetic-sha256' };
  } });
  const { uploadH3ReferenceImagesForTask } = load('src/lib/provider/h3-assets.ts');
  replies = [{ headers: { 'content-type': 'image/png' }, chunks: ['synthetic image'] }];
  const result = await uploadH3ReferenceImagesForTask({ firstFrameUrl: 'https://synthetic.invalid/first.png', options: { fetchImpl: providerFetch } });
  assert.equal(result.first_frame, 'h3-first.png'); assert.equal(uploads.length, 1);
  assert.equal(Buffer.from(uploads[0].contentB64, 'base64').toString(), 'synthetic image');
});
test('actual public media preview preserves bounded HEAD, range and size status', async () => {
  const { fetchPublicMedia } = load('src/lib/media/preview-response.ts');
  replies = [{ headers: { 'content-length': String(3 * 1024 * 1024 * 1024) } }];
  assert.equal((await fetchPublicMedia(new Request('https://site.invalid', { method: 'HEAD' }), 'https://synthetic.invalid/video', 'video/mp4')).status, 413);
  replies = [{ status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '2', 'content-range': 'bytes 2-3/4' }, chunks: ['34'] }];
  const response = await fetchPublicMedia(new Request('https://site.invalid', { headers: { Range: 'bytes=2-' } }), 'https://synthetic.invalid/video', 'video/mp4');
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 2-3/4');
  assert.equal(await response.text(), '34');
});
(async () => {
  let failed = 0;
  const selected = tests.filter(item => !process.env.AUD_NET_RED_ONLY || item.name.startsWith('actual '));
  for (const { name, run } of selected) { try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); } }
  console.log(`${selected.length - failed}/${selected.length} synthetic security contracts passed`);
  process.exitCode = failed ? 1 : 0;
})();
