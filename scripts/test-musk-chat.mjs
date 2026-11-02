import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = fs.realpathSync(process.cwd());
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const cache = new Map();

function load(relative) {
  const file = path.resolve(root, relative);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const source = fs.readFileSync(file, 'utf8');
  const localRequire = (id) => {
    if (id === 'server-only') return {};
    if (id === '@/lib/prisma') return { prisma: { asset: { findFirst: async () => { throw new Error('Unexpected database call'); } } } };
    if (id === '@/lib/image-studio/media') return { readStudioImage: async () => { throw new Error('Unexpected image read'); } };
    if (id === '@/lib/security/private-credentials.server') {
      return { readPrivateCredential: (value) => value, writePrivateCredential: (value) => value };
    }
    if (id === '@/lib/security/private-prompts.server') {
      return { isPrivatePromptError: () => false, isStoredPrivatePrompt: () => false, PrivatePromptError: class extends Error {} };
    }
    if (id === '@/lib/security/private-prompt-send.server') {
      return {
        assertPrivateSend: () => {},
        privateCredentialSendOrigins: () => [],
        privatePromptFetch: async (_destination, _origins, init, fetcher) => fetcher('https://fixture.invalid/v1/chat/completions', init),
      };
    }
    if (id.startsWith('@/') || id.startsWith('.')) {
      const base = id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : path.resolve(path.dirname(file), id);
      const found = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, 'index.ts')]
        .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!found) throw new Error(`Unresolved fixture import: ${id}`);
      return load(path.relative(root, found));
    }
    return require(id);
  };
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'fetch', output)(
    localRequire,
    module,
    module.exports,
    file,
    path.dirname(file),
    () => { throw new Error('External transport forbidden'); },
  );
  return module.exports;
}

const { createMuskChatCompletion, MuskApiError, openMuskChatStream } = load('src/lib/integrations/musk.ts');
const { MuskChatImageError, prepareMuskChatMessages } = load('src/lib/integrations/musk-chat-images.ts');
const settings = { enabled: true, base_url: 'https://fixture.invalid/', default_model: 'fixture-model', api_key: 'fixture-key', allowed_models: [] };
const messages = [{ role: 'user', content: 'fixture input' }];

async function expectMuskError(promise, message, code = 'musk_api_upstream_error') {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof MuskApiError);
    assert.equal(error.message, message);
    assert.equal(error.code, code);
    return true;
  });
}

async function testTransportRetries() {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    let calls = 0;
    const result = await createMuskChatCompletion({ settings, messages, retryDelayMs: 0, fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: { message: 'temporary overload' } }), { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    } });
    assert.equal(result.content, 'ok');
    assert.equal(calls, 2);

    calls = 0;
    await expectMuskError(createMuskChatCompletion({ settings, messages, retryDelayMs: 0, fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'no available channel' }), { status: 503 });
    } }), 'Musk API 调用失败 (HTTP 503)：no available channel');
    assert.equal(calls, 2);

    calls = 0;
    const longReason = 'x'.repeat(250);
    await expectMuskError(createMuskChatCompletion({ settings, messages, retryDelayMs: 0, fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: longReason } }), { status: 502 });
    } }), `Musk API 调用失败 (HTTP 502)：${'x'.repeat(200)}`);
    assert.equal(calls, 2);

    calls = 0;
    await expectMuskError(createMuskChatCompletion({ settings, messages, retryDelayMs: 0, fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: 'bad request' }), { status: 400 });
    } }), 'Musk API 调用失败 (HTTP 400)：bad request');
    assert.equal(calls, 1);

    const aborted = new AbortController();
    aborted.abort();
    calls = 0;
    await expectMuskError(createMuskChatCompletion({ settings, messages, signal: aborted.signal, retryDelayMs: 0, fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: 503 });
    } }), '请求已取消', 'musk_api_aborted');
    assert.equal(calls, 0);

    calls = 0;
    const stream = await openMuskChatStream({ settings, messages, retryDelayMs: 0, fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 429 })
        : new Response('data: {"choices":[]}\n\n', { status: 200 });
    } });
    assert.ok(stream.body);
    assert.equal(calls, 2);

    calls = 0;
    await expectMuskError(openMuskChatStream({ settings, messages, retryDelayMs: 0, fetchImpl: async () => {
      calls += 1;
      return new Response('gateway unavailable', { status: 504 });
    } }), 'Musk API 调用失败 (HTTP 504)：gateway unavailable');
    assert.equal(calls, 2);
  } finally {
    console.error = originalConsoleError;
  }
}

async function testOwnedImageInlining() {
  let finds = 0;
  let reads = 0;
  const dependencies = {
    findAsset: async () => {
      finds += 1;
      return { id: 'asset-1', original_url: '/uploads/assets/fixture.png', mime_type: 'image/png', file_size: 3 };
    },
    readImage: async () => {
      reads += 1;
      return Buffer.from([1, 2, 3]);
    },
  };
  const prepared = await prepareMuskChatMessages([{
    role: 'user',
    content: 'describe',
    images: [
      { id: 'asset-1', url: 'https://sd2.youdooart.com/uploads/assets/fixture.png' },
      { url: 'https://external.invalid/image.png' },
    ],
  }], 'owner-1', undefined, dependencies);
  const content = prepared[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, 'data:image/png;base64,AQID');
  assert.equal(content[2].type, 'image_url');
  assert.equal(content[2].image_url.url, 'https://external.invalid/image.png');
  assert.equal(content[0].type, 'text');
  assert.doesNotMatch(content[0].text, /data:image\/png|AQID/);
  assert.match(content[0].text, /已安全内联本人图片/);
  assert.match(content[0].text, /https:\/\/external\.invalid\/image\.png/);
  assert.equal(finds, 1);
  assert.equal(reads, 1);

  await assert.rejects(prepareMuskChatMessages([{
    role: 'user', content: 'describe', images: [{ id: 'asset-1', url: '/uploads/assets/other.png' }],
  }], 'owner-1', undefined, dependencies), (error) => {
    assert.ok(error instanceof MuskChatImageError);
    assert.equal(error.code, 'musk_chat_image_forbidden');
    return true;
  });

  await assert.rejects(prepareMuskChatMessages([{
    role: 'user', content: 'describe', images: [{ id: 'asset-1', url: '/uploads/assets/fixture.png' }],
  }], 'owner-1', undefined, {
    findAsset: async () => ({ id: 'asset-1', original_url: '/uploads/assets/fixture.png', mime_type: 'image/png', file_size: 8 * 1024 * 1024 + 1 }),
    readImage: async () => { throw new Error('should not read'); },
  }), (error) => {
    assert.ok(error instanceof MuskChatImageError);
    assert.equal(error.code, 'musk_chat_image_too_large');
    return true;
  });

  await assert.rejects(prepareMuskChatMessages([{
    role: 'user', content: 'describe', images: [{ id: 'asset-1', url: '/uploads/assets/fixture.png' }],
  }], 'owner-1', undefined, {
    findAsset: async () => ({ id: 'asset-1', original_url: '/uploads/assets/fixture.png', mime_type: 'image/png', file_size: 1 }),
    readImage: async () => Buffer.alloc(8 * 1024 * 1024 + 1),
  }), (error) => {
    assert.ok(error instanceof MuskChatImageError);
    assert.equal(error.code, 'musk_chat_image_too_large');
    return true;
  });
}

async function main() {
  await testTransportRetries();
  await testOwnedImageInlining();
  console.log('musk chat mock checks passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
