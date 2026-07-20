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

  const routeSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/assets/upload-ticket/route.ts'), 'utf8');
  assert.match(routeSource, /getSession\(\)/, 'upload-ticket route must require session');
  assert.match(routeSource, /createDirectUploadTicket/, 'upload-ticket route must use direct upload helper');

  const completeSource = fs.readFileSync(path.join(process.cwd(), 'src/app/api/assets/upload-complete/route.ts'), 'utf8');
  assert.match(completeSource, /getSession\(\)/, 'upload-complete route must require session');
  assert.match(completeSource, /completeDirectUpload/, 'upload-complete route must verify and register upload');

  const directUploadSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/assets/direct-upload.ts'), 'utf8');
  assert.match(directUploadSource, /hash: null/, 'direct uploads must not store client-provided hash as trusted file hash');
  assert.doesNotMatch(directUploadSource, /where:\s*{\s*owner_id:\s*input\.ownerId,\s*hash\s*}/, 'direct uploads must not reuse assets by client-provided hash');

  const clientSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/http/file-upload.ts'), 'utf8');
  assert.match(clientSource, /\/api\/assets\/upload-ticket/, 'client must request upload ticket');
  assert.match(clientSource, /\/api\/assets\/upload-complete/, 'client must complete direct upload');
  assert.match(clientSource, /buildRawFileUploadRequest/, 'client must keep raw upload fallback');
  assert.match(clientSource, /readJsonResponse<DirectUploadTicketResponse>[\s\S]+catch \(error\)[\s\S]+uploadWithRawFallback/, 'ticket non-json errors must fallback');
  assert.match(clientSource, /if \(!completeRes\.ok\) {[\s\S]+uploadWithRawFallback/, 'complete failures must fallback');
  assert.match(clientSource, /hash,/, 'client must send hash when creating ticket');

  console.log('direct-upload-r2-smoke: ok');
}

run()
  .finally(restoreEnv)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
