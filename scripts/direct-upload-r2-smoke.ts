import assert from 'assert';
import { webcrypto } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createDirectUploadTicket } from '../src/lib/assets/direct-upload';
import { uploadFileToHistory } from '../src/lib/http/file-upload';
import { calculateUploadTimeoutMs } from '../src/lib/http/upload-progress';

const smokeHash = 'a'.repeat(64);

const envKeys = [
  'R2_DIRECT_UPLOAD_ENABLED',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
  'R2_DIRECT_UPLOAD_CORS_VERIFIED',
] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

type MockUploadRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodySize: number;
  timeout: number;
};

function ensureWebCrypto() {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  }
}

function installBrowserUploadMocks(
  options: { proxySucceeds?: boolean; directUploadAvailable?: boolean } = {},
) {
  const requests: MockUploadRequest[] = [];
  const originalFetch = globalThis.fetch;
  const originalXhr = (globalThis as any).XMLHttpRequest;
  const originalImage = (globalThis as any).Image;
  const hadDocument = 'document' in globalThis;
  const originalDocument = (globalThis as any).document;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.equal(url, '/api/assets/upload-ticket', 'behavior smoke only expects upload-ticket fetch');
    if (options.directUploadAvailable) {
      return new Response(JSON.stringify({
        directUploadAvailable: true,
        storageProvider: 'r2',
        uploadUrl: 'https://r2.example.invalid/smoke-upload.mp4',
        uploadToken: 'smoke-upload-token',
        publicUrl: 'https://assets.example.invalid/smoke-upload.mp4',
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4' },
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      directUploadAvailable: false,
      storageProvider: 'r2',
      uploadToken: 'smoke-upload-token',
      reason: 'R2 直传未启用，正在使用服务端中转。',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  class MockImage {
    naturalWidth = 16;
    naturalHeight = 16;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  class MockMediaElement {
    duration = 5;
    preload = '';
    onloadedmetadata: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => this.onloadedmetadata?.());
    }
  }

  class MockXMLHttpRequest {
    method = 'POST';
    url = '';
    timeout = 0;
    status = 0;
    responseText = '';
    headers: Record<string, string> = {};
    upload = { onprogress: null as ((event: any) => void) | null };
    onload: ((event?: any) => void) | null = null;
    onerror: ((event?: any) => void) | null = null;
    onabort: ((event?: any) => void) | null = null;
    ontimeout: ((event?: any) => void) | null = null;

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(key: string, value: string) {
      this.headers[key] = value;
    }

    send(body: XMLHttpRequestBodyInit | Document) {
      const bodySize = typeof (body as Blob).size === 'number' ? (body as Blob).size : 0;
      requests.push({ method: this.method, url: this.url, headers: this.headers, bodySize, timeout: this.timeout });
      this.upload.onprogress?.({ loaded: bodySize, total: bodySize, lengthComputable: true });
      queueMicrotask(() => {
        if (this.url === 'https://r2.example.invalid/smoke-upload.mp4') {
          this.onerror?.({});
          return;
        }
        if (this.url === '/api/assets/upload-proxy') {
          if (options.proxySucceeds) {
            this.status = 200;
            this.responseText = JSON.stringify({
              success: true,
              asset: {
                id: 'proxy-upload-asset',
                originalUrl: 'https://example.invalid/proxy-upload.mp4',
                thumbnailUrl: null,
                fileName: 'upload.mp4',
                fileSize: bodySize,
                mimeType: this.headers['Content-Type'] || 'application/octet-stream',
              },
            });
            this.onload?.({});
            return;
          }
          this.onerror?.({});
          return;
        }
        if (this.url === '/api/assets/upload') {
          this.status = 200;
          this.responseText = JSON.stringify({
            success: true,
            asset: {
              id: 'raw-fallback-asset',
              originalUrl: 'https://example.invalid/raw.png',
              thumbnailUrl: 'https://example.invalid/raw-thumb.png',
            },
          });
          this.onload?.({});
          return;
        }
        this.status = 404;
        this.responseText = JSON.stringify({ error: `unexpected upload url ${this.url}` });
        this.onload?.({});
      });
    }
  }

  (globalThis as any).Image = MockImage;
  (globalThis as any).document = {
    createElement(tagName: string) {
      assert.match(tagName, /^(video|audio)$/, 'video upload behavior smoke only expects media elements');
      return new MockMediaElement();
    },
  };
  (globalThis as any).XMLHttpRequest = MockXMLHttpRequest;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:smoke-upload' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });

  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
      (globalThis as any).XMLHttpRequest = originalXhr;
      (globalThis as any).Image = originalImage;
      if (hadDocument) (globalThis as any).document = originalDocument;
      else delete (globalThis as any).document;
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectUrl });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectUrl });
    },
  };
}

async function assertVideoProxyUploadBehavior() {
  ensureWebCrypto();
  const successMocks = installBrowserUploadMocks({ proxySucceeds: true });
  try {
    const video = new File([new Uint8Array(1024)], 'clip.mp4', { type: 'video/mp4' });
    const progressEvents: Array<{ phase: string; label: string; percent?: number }> = [];
    const asset = await uploadFileToHistory(video, {
      onProgress: (progress) => progressEvents.push({
        phase: progress.phase,
        label: progress.label,
        ...(progress.percent != null ? { percent: progress.percent } : {}),
      }),
    });
    assert.equal(asset.id, 'proxy-upload-asset', 'video upload must use the server proxy asset result');
    assert.deepEqual(
      successMocks.requests.map((request) => request.url),
      ['/api/assets/upload-proxy'],
      'video upload must use proxy and must not raw fallback on success',
    );
    assert.equal(successMocks.requests[0]?.headers['X-Media-Duration'], '5', 'video upload must pass client-read media duration to proxy');
    assert.equal(successMocks.requests[0]?.timeout, 120000, 'small proxy uploads must keep the existing minimum timeout');
    assert.deepEqual(
      progressEvents.map((event) => event.phase),
      ['preparing', 'ticket', 'proxy', 'proxy', 'done'],
      'video upload must emit visible progress states from file metadata through completion',
    );
    assert.equal(
      progressEvents.find((event) => event.phase === 'proxy' && event.percent === 100)?.label,
      '正在服务端中转上传',
      'video proxy upload must expose a real measured upload percentage',
    );
    assert.equal(
      progressEvents[progressEvents.length - 1]?.label,
      '上传完成',
      'video upload must expose a completion progress state',
    );
  } finally {
    successMocks.restore();
  }

  const failureMocks = installBrowserUploadMocks();
  try {
    const video = new File([new Uint8Array(1024)], 'clip.mp4', { type: 'video/mp4' });
    await assert.rejects(
      () => uploadFileToHistory(video),
      /当前视频不能自动改用普通上传/,
      'video upload must not silently fall back to raw upload when proxy fails',
    );
    assert.deepEqual(
      failureMocks.requests.map((request) => request.url),
      ['/api/assets/upload-proxy'],
      'video upload must stop after proxy failure and avoid raw fallback',
    );
  } finally {
    failureMocks.restore();
  }

  const directPutFailureMocks = installBrowserUploadMocks({
    directUploadAvailable: true,
    proxySucceeds: true,
  });
  try {
    const video = new File([new Uint8Array(1024)], 'clip.mp4', { type: 'video/mp4' });
    const asset = await uploadFileToHistory(video);
    assert.equal(asset.id, 'proxy-upload-asset', 'video upload must use proxy when browser storage PUT fails');
    assert.deepEqual(
      directPutFailureMocks.requests.map((request) => request.url),
      ['https://r2.example.invalid/smoke-upload.mp4', '/api/assets/upload-proxy'],
      'video upload must try browser PUT, then proxy, and must not raw fallback',
    );
    assert.equal(
      directPutFailureMocks.requests[1]?.headers['X-Media-Duration'],
      '5',
      'video upload must preserve media duration when falling back from browser PUT to proxy',
    );
  } finally {
    directPutFailureMocks.restore();
  }

  const directPutAndProxyFailureMocks = installBrowserUploadMocks({ directUploadAvailable: true });
  try {
    const video = new File([new Uint8Array(1024)], 'clip.mp4', { type: 'video/mp4' });
    await assert.rejects(
      () => uploadFileToHistory(video),
      /当前视频不能自动改用普通上传/,
      'video upload must not raw fallback after both browser PUT and proxy fail',
    );
    assert.deepEqual(
      directPutAndProxyFailureMocks.requests.map((request) => request.url),
      ['https://r2.example.invalid/smoke-upload.mp4', '/api/assets/upload-proxy'],
      'video upload must stop after proxy failure and avoid raw fallback',
    );
  } finally {
    directPutAndProxyFailureMocks.restore();
  }
}

async function assertProxyFailureRawFallbackBehavior() {
  ensureWebCrypto();

  const smallMocks = installBrowserUploadMocks();
  try {
    const smallImage = new File([new Uint8Array(1024)], 'small.png', { type: 'image/png' });
    const asset = await uploadFileToHistory(smallImage);
    assert.equal(asset.id, 'raw-fallback-asset', 'small image must return the raw fallback asset when direct upload is unavailable');
    assert.deepEqual(
      smallMocks.requests.map((request) => request.url),
      ['/api/assets/upload'],
      'small image must skip proxy and use raw upload directly when direct upload is unavailable',
    );
  } finally {
    smallMocks.restore();
  }

  const largeMocks = installBrowserUploadMocks();
  try {
    const largeImage = new File([new Uint8Array(30 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' });
    await assert.rejects(
      () => uploadFileToHistory(largeImage),
      /仅支持 30MB 以内图片或 15MB 以内音频自动回退/,
      'large images must not silently fall back to raw upload',
    );
    assert.deepEqual(
      largeMocks.requests.map((request) => request.url),
      ['/api/assets/upload-proxy'],
      'large image must stop after proxy failure and avoid raw fallback',
    );
  } finally {
    largeMocks.restore();
  }

  const audioMocks = installBrowserUploadMocks();
  try {
    const audio = new File([new Uint8Array(1024)], 'voice.mp3', { type: 'audio/mpeg' });
    const asset = await uploadFileToHistory(audio);
    assert.equal(asset.id, 'raw-fallback-asset', 'small audio must return the raw fallback asset when direct upload is unavailable');
    assert.deepEqual(
      audioMocks.requests.map((request) => request.url),
      ['/api/assets/upload'],
      'small audio must skip proxy and use raw upload directly when direct upload is unavailable',
    );
  } finally {
    audioMocks.restore();
  }
}

async function run() {
  assert.equal(calculateUploadTimeoutMs(1024), 120000, 'small uploads keep the minimum timeout');
  assert.ok(calculateUploadTimeoutMs(15 * 1024 * 1024) > 120000, 'larger uploads must get a size-aware timeout');
  assert.ok(calculateUploadTimeoutMs(500 * 1024 * 1024) <= 10 * 60_000, 'upload timeout must stay capped');

  for (const key of envKeys) delete process.env[key];
  const unavailable = await createDirectUploadTicket({
    ownerId: 'smoke-user',
    fileName: 'ok.png',
    mimeType: 'image/png',
    fileSize: 1024,
    hash: smokeHash,
  });
  assert.equal(unavailable.directUploadAvailable, false);

  await assert.rejects(
    () => createDirectUploadTicket({
      ownerId: 'smoke-user',
      fileName: 'bad.bin',
      mimeType: 'application/octet-stream',
      fileSize: 1024,
      hash: smokeHash,
    }),
    /不支持的文件类型/,
  );

  await assert.rejects(
    () => createDirectUploadTicket({
      ownerId: 'smoke-user',
      fileName: 'huge.png',
      mimeType: 'image/png',
      fileSize: 31 * 1024 * 1024,
      hash: smokeHash,
    }),
    /图片过大/,
  );

  await assert.rejects(
    () => createDirectUploadTicket({
      ownerId: 'smoke-user',
      fileName: 'bad-hash.png',
      mimeType: 'image/png',
      fileSize: 1024,
      hash: 'bad',
    }),
    /文件校验信息无效/,
  );

  process.env.R2_ACCOUNT_ID = 'smoke-account';
  process.env.R2_ACCESS_KEY_ID = 'smoke-access-key';
  process.env.R2_SECRET_ACCESS_KEY = 'smoke-secret-key';
  process.env.R2_BUCKET = 'smoke-bucket';
  process.env.R2_PUBLIC_BASE_URL = 'https://assets.example.com';
  delete process.env.R2_DIRECT_UPLOAD_ENABLED;

  const proxyOnlyTicket = await createDirectUploadTicket({
    ownerId: 'smoke-user',
    fileName: '../unsafe name.png',
    mimeType: 'image/png',
    fileSize: 1024,
    hash: smokeHash,
  });
  if (proxyOnlyTicket.directUploadAvailable !== false) {
    throw new Error('browser direct PUT must be opt-in when R2 CORS is unknown');
  }
  if (!('uploadToken' in proxyOnlyTicket)) {
    throw new Error('expected R2 proxy ticket when R2 is configured and browser direct upload is disabled');
  }
  assert.equal(Boolean(proxyOnlyTicket.uploadToken), true, 'R2 configured but browser direct disabled must still provide server-proxy upload token');
  assert.equal('uploadUrl' in proxyOnlyTicket, false, 'server-proxy ticket must not expose a browser PUT URL');
  assert.match(proxyOnlyTicket.reason, /中转|CORS|直传/);

  process.env.R2_DIRECT_UPLOAD_ENABLED = 'true';
  delete process.env.R2_DIRECT_UPLOAD_CORS_VERIFIED;
  const corsUnverified = await createDirectUploadTicket({
    ownerId: 'smoke-user',
    fileName: 'cors-unverified.png',
    mimeType: 'image/png',
    fileSize: 1024,
    hash: smokeHash,
  });
  if (corsUnverified.directUploadAvailable !== false) {
    throw new Error('direct upload must stay disabled until R2 CORS is explicitly verified');
  }
  if (!('uploadToken' in corsUnverified)) {
    throw new Error('CORS-unverified direct upload must keep server proxy available');
  }

  process.env.R2_DIRECT_UPLOAD_CORS_VERIFIED = 'true';
  const ticket = await createDirectUploadTicket({
    ownerId: 'smoke-user',
    fileName: '../unsafe name.png',
    mimeType: 'image/png',
    fileSize: 1024,
    hash: smokeHash,
  });
  if (ticket.directUploadAvailable !== true) {
    throw new Error('expected R2 direct upload ticket to be available');
  }
  assert.equal(ticket.method, 'PUT');
  assert.equal(ticket.headers['Content-Type'], 'image/png');
  assert.match(ticket.uploadUrl, /^https:\/\/smoke-bucket\.smoke-account\.r2\.cloudflarestorage\.com\/seedance-direct-uploads\//);
  assert.match(ticket.publicUrl, /^https:\/\/assets\.example\.com\/seedance-direct-uploads\//);
  assert.ok(ticket.uploadUrl.includes('X-Amz-Signature='));
  assert.equal(ticket.uploadUrl.includes('smoke-secret-key'), false);
  assert.equal(ticket.uploadToken.includes('smoke-secret-key'), false);

  process.env.R2_DIRECT_UPLOAD_ENABLED = 'false';
  const explicitlyDisabled = await createDirectUploadTicket({
    ownerId: 'smoke-user',
    fileName: 'disabled.png',
    mimeType: 'image/png',
    fileSize: 1024,
    hash: smokeHash,
  });
  if (explicitlyDisabled.directUploadAvailable !== false) {
    throw new Error('explicit false flag must disable browser direct upload');
  }
  if (!('uploadToken' in explicitlyDisabled)) {
    throw new Error('expected R2 proxy ticket when direct upload is explicitly disabled');
  }
  assert.equal(Boolean(explicitlyDisabled.uploadToken), true, 'explicit false must keep same-origin server proxy available when R2 is configured');

  const routeSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/assets/upload-ticket/route.ts'), 'utf8');
  assert.match(routeSource, /getSession\(\)/, 'upload-ticket route must require session');
  assert.match(routeSource, /createDirectUploadTicket/, 'upload-ticket route must use direct upload helper');

  const completeSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/assets/upload-complete/route.ts'), 'utf8');
  assert.match(completeSource, /getSession\(\)/, 'upload-complete route must require session');
  assert.match(completeSource, /completeDirectUpload/, 'upload-complete route must verify and register upload');

  const proxySource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/assets/upload-proxy/route.ts'), 'utf8');
  assert.match(proxySource, /getSession\(\)/, 'upload-proxy route must require session');
  assert.match(proxySource, /proxyDirectUploadToStorage/, 'upload-proxy route must use the direct upload proxy helper');
  assert.match(proxySource, /Readable\.fromWeb/, 'upload-proxy route must stream the request body to storage');

  const rawUploadRouteSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/assets/upload/route.ts'), 'utf8');
  assert.match(rawUploadRouteSource, /export const maxDuration = 180/, 'raw upload fallback must have the same server window as upload-proxy');

  const directUploadSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/assets/direct-upload.ts'), 'utf8');
  assert.match(directUploadSource, /createHashingUploadBody/, 'server-proxy uploads must hash the real uploaded stream on the server');
  assert.match(directUploadSource, /trustedHash\?: string \| null/, 'trusted hashes must be explicit and separate from client-provided hashes');
  assert.match(directUploadSource, /hash: trustedHash/, 'only server-verified upload hashes may be stored for later reuse');
  assert.match(directUploadSource, /findActiveAssetByTrustedHash/, 'trusted uploaded hashes must be reusable without uploading duplicate bytes');
  assert.match(directUploadSource, /owner_id: ownerId[\s\S]+hash: trustedHash[\s\S]+const sharedAsset = await prisma\.asset\.findFirst/, 'trusted hash reuse must prefer current owner, then reuse a shared matching file URL');
  assert.match(directUploadSource, /directUploadAvailable: false,[\s\S]+reused: true,[\s\S]+asset: assetRecordToPayload/, 'ticket creation must return an immediate reuse result for existing same-owner hashes');
  assert.match(directUploadSource, /hashingBody\.digest\(\)/, 'server-proxy upload must finish with the hash of the actual uploaded bytes');
  assert.match(directUploadSource, /proxyDirectUploadToStorage/, 'direct upload helper must expose a server-side proxy fallback');
  assert.match(directUploadSource, /ContentLength:\s*payload\.fileSize/, 'server-side proxy fallback must preserve ticket file size');

  const clientSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/http/file-upload.ts'), 'utf8');
  const rawFallbackSource = clientSource.slice(
    clientSource.indexOf('async function uploadWithRawFallback'),
    clientSource.indexOf('function canUseRawFallback'),
  );
  const proxyFallbackSource = clientSource.slice(
    clientSource.indexOf('async function uploadWithServerProxy'),
    clientSource.indexOf('async function sha256File'),
  );
  const clientTicketSource = clientSource.slice(
    clientSource.indexOf('let ticket: DirectUploadTicketResponse'),
    clientSource.indexOf('if (!ticketRes.ok)'),
  );
  const clientCompleteStart = clientSource.indexOf('let complete: UploadAssetResponse');
  const clientCompleteSource = clientSource.slice(
    clientCompleteStart,
    clientSource.indexOf('if (!completeRes.ok)', clientCompleteStart),
  );
  const directUnavailableSource = clientSource.slice(
    clientSource.indexOf('if (ticket.directUploadAvailable === false)'),
    clientSource.indexOf('if (!ticket.uploadUrl'),
  );
  assert.match(clientSource, /\/api\/assets\/upload-ticket/, 'client must request upload ticket');
  assert.match(clientSource, /\/api\/assets\/upload-complete/, 'client must complete direct upload');
  assert.match(clientSource, /\/api\/assets\/upload-proxy/, 'client must use same-origin server proxy when R2 browser PUT fails');
  assert.match(clientSource, /buildRawFileUploadRequest/, 'client must keep raw upload fallback');
  assert.match(clientSource, /type UploadProgressHandler/, 'client upload helper must expose a reusable progress handler');
  assert.match(clientSource, /onProgress\?: UploadProgressHandler/, 'client upload helper must accept real upload progress callbacks');
  assert.match(clientSource, /notifyUploadProgress/, 'client upload helper must emit measured progress snapshots');
  assert.match(clientSource, /requestJsonWithUploadProgress<UploadAssetResponse>/, 'same-origin upload requests must use XHR upload progress');
  assert.match(clientSource, /calculateUploadTimeoutMs\(file\.size\)/, 'browser storage PUT must use a size-aware upload timeout');
  assert.match(clientSource, /uploadStageTimeoutMessage\('普通上传'\)/, 'raw fallback timeouts must be shown as slow uploads, not generic network interruptions');
  assert.match(clientSource, /uploadStageTimeoutMessage\('服务端中转上传'\)/, 'proxy fallback timeouts must be shown as slow uploads, not generic network interruptions');
  assert.match(clientSource, /IMAGE_RAW_FALLBACK_MAX_SIZE_BYTES = 30 \* 1024 \* 1024/, 'image raw upload fallback must match the site image upload limit');
  assert.match(clientSource, /AUDIO_RAW_FALLBACK_MAX_SIZE_BYTES = 15 \* 1024 \* 1024/, 'audio raw upload fallback must stay within the existing audio upload limit');
  assert.doesNotMatch(clientSource, /连接中断[\s\S]+文件较大，请压缩后重试/, 'generic connection errors must not mislead users into thinking small files are oversized');
  assert.match(clientSource, /file\.type\.startsWith\('image\/'\)/, 'raw upload fallback must support bounded image uploads');
  assert.match(clientSource, /file\.type\.startsWith\('audio\/'\)/, 'raw upload fallback must support bounded audio uploads');
  assert.match(clientSource, /R2 CORS/, 'direct upload failures must tell admins to check R2 CORS');
  assert.match(clientTicketSource, /fetch\('\/api\/assets\/upload-ticket'[\s\S]+catch \(error\)[\s\S]+uploadStageConnectionMessage\('上传票据创建', error\)[\s\S]+uploadWithRawFallbackOrThrow\(file, invalidJsonMessage, fallbackToRaw, message, onProgress\)/, 'ticket connection errors must show upload-ticket stage context');
  assert.match(clientTicketSource, /readUploadJsonResponse<DirectUploadTicketResponse>\(ticketRes, '上传票据接口', invalidJsonMessage\)[\s\S]+catch \(error\)[\s\S]+uploadWithRawFallbackOrThrow\(file, invalidJsonMessage, fallbackToRaw, message, onProgress\)/, 'ticket non-json errors must fallback safely or show a clear bounded error');
  assert.match(clientSource, /ticketRes\.status >= 500[\s\S]+uploadWithRawFallbackOrThrow/, 'ticket server errors must use the safe fallback boundary');
  assert.match(clientSource, /putFileToStorage[\s\S]+catch \(error\)[\s\S]+uploadWithServerProxy/, 'object storage PUT failure must try same-origin server proxy before giving up');
  assert.doesNotMatch(proxyFallbackSource, /catch \(proxyError\)[\s\S]+shouldUseRawFallback\(file, fallbackToRaw\)[\s\S]+uploadWithRawFallback/, 'raw fallback must not wait behind proxy failure for safe small images or audio');
  assert.match(rawFallbackSource, /requestJsonWithUploadProgress<UploadAssetResponse>/, 'raw fallback must report real browser upload progress');
  assert.match(rawFallbackSource, /phase:\s*'raw'/, 'raw fallback progress must identify the raw upload phase');
  assert.doesNotMatch(rawFallbackSource, /readJsonResponse<UploadAssetResponse>\(res, \{ invalidJsonMessage \}\)/, 'raw fallback must not leak the generic upload invalid-json message');
  assert.match(proxyFallbackSource, /requestJsonWithUploadProgress<UploadAssetResponse>/, 'server proxy fallback must report real browser upload progress');
  assert.match(proxyFallbackSource, /phase:\s*'proxy'/, 'server proxy progress must identify the proxy upload phase');
  assert.doesNotMatch(proxyFallbackSource, /readJsonResponse<UploadAssetResponse>\(res, \{ invalidJsonMessage \}\)/, 'server proxy fallback must not leak the generic upload invalid-json message');
  assert.match(clientSource, /xhr\.upload\.onprogress/, 'object storage PUT must use XHR upload progress');
  assert.match(clientSource, /phase:\s*'storage'/, 'object storage upload progress must identify the storage phase');
  assert.match(clientSource, /phase:\s*'complete'/, 'completion registration must show a stage instead of fake percent');
  assert.match(clientSource, /phase:\s*'done'/, 'successful upload must finish at measured 100 percent');
  assert.match(clientSource, /ticket\.reused === true[\s\S]+ticket\.asset\?\.id[\s\S]+已复用相同素材[\s\S]+return ticket\.asset/, 'client must complete immediately when upload-ticket returns an existing same-file asset');
  assert.match(clientCompleteSource, /fetch\('\/api\/assets\/upload-complete'[\s\S]+catch \(error\)[\s\S]+uploadStageConnectionMessage\('上传完成登记', error\)[\s\S]+uploadWithRawFallbackOrThrow\(file, invalidJsonMessage, fallbackToRaw, message, onProgress\)/, 'complete connection errors must show upload-complete stage context');
  assert.match(clientCompleteSource, /readUploadJsonResponse<UploadAssetResponse>\(completeRes, '上传完成登记接口', invalidJsonMessage\)[\s\S]+catch \(error\)[\s\S]+uploadWithRawFallbackOrThrow\(file, invalidJsonMessage, fallbackToRaw, message, onProgress\)/, 'complete non-json errors must fallback safely or show a clear bounded error');
  assert.doesNotMatch(clientCompleteSource, /if \(!completeRes\.ok\) {[\s\S]+uploadWithRawFallbackOrThrow/, 'complete JSON failures must not fallback to raw upload after object storage succeeds');
  assert.match(clientSource, /ticket\.directUploadAvailable === false[\s\S]+uploadWithRawFallbackOrThrow/, 'client must use raw upload directly when browser PUT is intentionally unavailable and raw fallback is safe');
  assert.match(clientSource, /ticket\.directUploadAvailable === false[\s\S]+uploadWithServerProxy/, 'client must keep same-origin proxy for files that cannot use raw fallback');
  assert.doesNotMatch(directUnavailableSource, /uploadWithServerProxyOrRawFallback[\s\S]+fallbackToRaw[\s\S]+ticket\.reason \|\| '直传暂不可用'/, 'direct-disabled safe files must not proxy first before raw upload');
  assert.ok(
    directUnavailableSource.indexOf('shouldUseRawFallback(file, fallbackToRaw)') < directUnavailableSource.indexOf('uploadWithServerProxy('),
    'direct-disabled branch must check raw fallback before using proxy for files that cannot use raw',
  );
  assert.match(clientSource, /hash,/, 'client must send hash when creating ticket');

  await assertProxyFailureRawFallbackBehavior();
  await assertVideoProxyUploadBehavior();

  console.log('direct-upload-r2-smoke: ok');
}

run()
  .finally(restoreEnv)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
