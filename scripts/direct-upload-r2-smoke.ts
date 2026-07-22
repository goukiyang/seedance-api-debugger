import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createDirectUploadTicket } from '../src/lib/assets/direct-upload';

const smokeHash = 'a'.repeat(64);

const envKeys = [
  'R2_DIRECT_UPLOAD_ENABLED',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

async function run() {
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

  const directUploadSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/assets/direct-upload.ts'), 'utf8');
  assert.match(directUploadSource, /createHashingUploadBody/, 'server-proxy uploads must hash the real uploaded stream on the server');
  assert.match(directUploadSource, /trustedHash\?: string \| null/, 'trusted hashes must be explicit and separate from client-provided hashes');
  assert.match(directUploadSource, /hash: trustedHash/, 'only server-verified upload hashes may be stored for later reuse');
  assert.match(directUploadSource, /findActiveAssetByTrustedHash/, 'trusted uploaded hashes must be reusable by the same owner');
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
  const clientCompleteSource = clientSource.slice(
    clientSource.indexOf('let complete: UploadAssetResponse'),
    clientSource.indexOf('if (!completeRes.ok)'),
  );
  assert.match(clientSource, /\/api\/assets\/upload-ticket/, 'client must request upload ticket');
  assert.match(clientSource, /\/api\/assets\/upload-complete/, 'client must complete direct upload');
  assert.match(clientSource, /\/api\/assets\/upload-proxy/, 'client must use same-origin server proxy when R2 browser PUT fails');
  assert.match(clientSource, /buildRawFileUploadRequest/, 'client must keep raw upload fallback');
  assert.match(clientSource, /type UploadProgressHandler/, 'client upload helper must expose a reusable progress handler');
  assert.match(clientSource, /onProgress\?: UploadProgressHandler/, 'client upload helper must accept real upload progress callbacks');
  assert.match(clientSource, /notifyUploadProgress/, 'client upload helper must emit measured progress snapshots');
  assert.match(clientSource, /requestJsonWithUploadProgress<UploadAssetResponse>/, 'same-origin upload requests must use XHR upload progress');
  assert.match(clientSource, /RAW_FALLBACK_MAX_SIZE_BYTES = 8 \* 1024 \* 1024/, 'raw upload fallback must be size-limited');
  assert.match(clientSource, /file\.type\.startsWith\('image\/'\)/, 'raw upload fallback must be limited to image uploads');
  assert.match(clientSource, /R2 CORS/, 'direct upload failures must tell admins to check R2 CORS');
  assert.match(clientTicketSource, /fetch\('\/api\/assets\/upload-ticket'[\s\S]+catch \(error\)[\s\S]+uploadStageConnectionMessage\('上传票据创建', error\)[\s\S]+uploadWithRawFallbackOrThrow\(file, invalidJsonMessage, fallbackToRaw, message, onProgress\)/, 'ticket connection errors must show upload-ticket stage context');
  assert.match(clientTicketSource, /readUploadJsonResponse<DirectUploadTicketResponse>\(ticketRes, '上传票据接口', invalidJsonMessage\)[\s\S]+catch \(error\)[\s\S]+uploadWithRawFallbackOrThrow\(file, invalidJsonMessage, fallbackToRaw, message, onProgress\)/, 'ticket non-json errors must fallback safely or show a clear bounded error');
  assert.match(clientSource, /ticketRes\.status >= 500[\s\S]+uploadWithRawFallbackOrThrow/, 'ticket server errors must use the safe fallback boundary');
  assert.match(clientSource, /putFileToStorage[\s\S]+catch \(error\)[\s\S]+uploadWithServerProxy/, 'object storage PUT failure must try same-origin server proxy before giving up');
  assert.match(clientSource, /uploadWithServerProxy[\s\S]+catch \(proxyError\)[\s\S]+shouldUseRawFallback\(file, fallbackToRaw\)[\s\S]+uploadWithRawFallback/, 'raw fallback must stay behind proxy failure and the safe fallback guard');
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
  assert.match(clientSource, /ticket\.directUploadAvailable === false[\s\S]+uploadWithServerProxy/, 'client must use same-origin proxy directly when browser PUT is intentionally unavailable');
  assert.match(clientSource, /ticket\.directUploadAvailable === false[\s\S]+uploadWithRawFallback/, 'client must keep raw upload fallback when no proxy ticket exists');
  assert.match(clientSource, /hash,/, 'client must send hash when creating ticket');

  console.log('direct-upload-r2-smoke: ok');
}

run()
  .finally(restoreEnv)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
