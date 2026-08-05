import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createDirectUploadTicket } from '../src/lib/assets/direct-upload';

const LIVE_FLAG = '--live';
const DEFAULT_ORIGIN = 'https://sd2.youdoodesign.com';

const REQUIRED_ENV = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
] as const;

function env(name: string) {
  return (process.env[name] || '').trim();
}

function hasRequiredEnv() {
  return REQUIRED_ENV.every((name) => Boolean(env(name)));
}

function envFlagEnabled(value: string | undefined) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes((value || '').trim().toLowerCase());
}

function headerIncludes(headers: Headers, name: string, expected: string) {
  const value = headers.get(name) || '';
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .includes(expected.toLowerCase()) || value.trim() === '*';
}

function createR2CleanupClient() {
  const accountId = env('R2_ACCOUNT_ID');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env('R2_ACCESS_KEY_ID'),
      secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    },
  });
}

function objectKeyFromPublicUrl(publicUrl: string) {
  const base = env('R2_PUBLIC_BASE_URL').replace(/\/$/, '');
  if (!publicUrl.startsWith(`${base}/`)) throw new Error('公开 URL 和 R2_PUBLIC_BASE_URL 不匹配');
  return decodeURIComponent(publicUrl.slice(base.length + 1));
}

async function cleanupObject(publicUrl: string) {
  const key = objectKeyFromPublicUrl(publicUrl);
  await createR2CleanupClient().send(new DeleteObjectCommand({
    Bucket: env('R2_BUCKET'),
    Key: key,
  }));
}

async function main() {
  const live = process.argv.includes(LIVE_FLAG) || envFlagEnabled(process.env.R2_CORS_READINESS_LIVE);
  const origin = env('R2_CORS_READINESS_ORIGIN') || DEFAULT_ORIGIN;

  if (!hasRequiredEnv()) {
    console.log('r2-cors-readiness-smoke: skipped, R2 env is incomplete');
    return;
  }

  if (!live) {
    console.log('r2-cors-readiness-smoke: config ok; run with --live to verify OPTIONS/PUT/ETag/public HEAD');
    return;
  }

  const previousDirect = process.env.R2_DIRECT_UPLOAD_ENABLED;
  const previousCors = process.env.R2_DIRECT_UPLOAD_CORS_VERIFIED;
  process.env.R2_DIRECT_UPLOAD_ENABLED = 'true';
  process.env.R2_DIRECT_UPLOAD_CORS_VERIFIED = 'true';

  const payload = Buffer.concat([
    Buffer.from('sd2-r2-cors-readiness-'),
    randomBytes(16),
  ]);
  const hash = createHash('sha256').update(payload).digest('hex');
  let publicUrl: string | null = null;

  try {
    const ticket = await createDirectUploadTicket({
      ownerId: 'r2-cors-readiness-smoke',
      fileName: `r2-cors-readiness-${Date.now()}.png`,
      mimeType: 'image/png',
      fileSize: payload.byteLength,
      hash,
    });
    if (ticket.directUploadAvailable !== true) {
      throw new Error('R2 CORS readiness 无法生成直传票据，请先确认 R2 配置完整。');
    }
    publicUrl = ticket.publicUrl;

    const preflight = await fetch(ticket.uploadUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.ok(preflight.ok, `CORS preflight failed: HTTP ${preflight.status}`);
    assert.ok(headerIncludes(preflight.headers, 'access-control-allow-methods', 'PUT'), 'CORS must allow PUT');
    assert.ok(headerIncludes(preflight.headers, 'access-control-allow-headers', 'content-type'), 'CORS must allow Content-Type');

    const put = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: {
        Origin: origin,
        ...ticket.headers,
      },
      body: payload,
    });
    assert.ok(put.ok, `R2 PUT failed: HTTP ${put.status}`);
    assert.ok(put.headers.get('ETag'), 'R2 PUT must return ETag');
    assert.ok(headerIncludes(put.headers, 'access-control-expose-headers', 'etag'), 'CORS must expose ETag for multipart completion');

    const publicHead = await fetch(publicUrl, { method: 'HEAD' });
    assert.ok(publicHead.ok, `R2 public URL HEAD failed: HTTP ${publicHead.status}`);

    console.log('r2-cors-readiness-smoke: ok');
  } finally {
    if (publicUrl) {
      await cleanupObject(publicUrl).catch((error) => {
        console.warn('[r2-cors-readiness-smoke] cleanup failed:', error instanceof Error ? error.message : String(error));
      });
    }
    if (previousDirect == null) delete process.env.R2_DIRECT_UPLOAD_ENABLED;
    else process.env.R2_DIRECT_UPLOAD_ENABLED = previousDirect;
    if (previousCors == null) delete process.env.R2_DIRECT_UPLOAD_CORS_VERIFIED;
    else process.env.R2_DIRECT_UPLOAD_CORS_VERIFIED = previousCors;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
