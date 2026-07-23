import crypto from 'node:crypto';
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'session';
const sessionSecret = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

function buildSessionCookie(userId: string) {
  const payload = Buffer.from(userId).toString('base64');
  const sig = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64');
  return `${sessionCookieName}=${payload}.${sig}`;
}

function fail(message: string): never {
  throw new Error(message);
}

async function main() {
  const runId = `dup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const uploaderId = `smoke_uploader_${runId}`;
  const albumId = `smoke_album_${runId}`;
  const assetId = `smoke_asset_${runId}`;
  const content = Buffer.from(`reference-album-duplicate-upload:${runId}`);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const originalUrl = `https://example.invalid/smoke/${runId}.png`;
  const thumbnailUrl = `https://example.invalid/smoke/${runId}_thumb.png`;

  try {
    await prisma.user.create({
      data: {
        id: uploaderId,
        name: 'Smoke Uploader',
        username: `${runId}_uploader`,
        email: `${runId}_uploader@example.invalid`,
        password_hash: 'smoke-only',
        role: 'user',
        account_type: 'internal',
        status: 'active',
      },
    });
    await prisma.asset.create({
      data: {
        id: assetId,
        owner_id: uploaderId,
        type: 'image',
        original_url: originalUrl,
        thumbnail_url: thumbnailUrl,
        file_name: `${runId}.png`,
        mime_type: 'image/png',
        file_size: content.length,
        hash,
        status: 'active',
      },
    });
    await prisma.referenceAlbum.create({
      data: {
        id: albumId,
        owner_user_id: uploaderId,
        name: `重复上传 smoke ${runId}`,
        album_type: 'personal',
        visibility: 'private',
        status: 'active',
      },
    });

    const response = await fetch(`${baseUrl}/api/reference-albums/${albumId}/images`, {
      method: 'POST',
      headers: {
        Cookie: buildSessionCookie(uploaderId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assetIds: [assetId],
        source_type: 'upload',
        metadata_json: {
          source: 'album_asset_upload_integration',
          original_file_names: [`${runId}.png`],
        },
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status !== 201) {
      fail(`POST assetIds returned ${response.status}: ${JSON.stringify(payload)}`);
    }

    const multipartData = new FormData();
    multipartData.append('file', new Blob([content], { type: 'image/png' }), `${runId}.png`);
    const multipartResponse = await fetch(`${baseUrl}/api/reference-albums/${albumId}/images`, {
      method: 'POST',
      headers: { Cookie: buildSessionCookie(uploaderId) },
      body: multipartData,
    });
    const multipartPayload = await multipartResponse.json().catch(() => ({}));
    if (multipartResponse.status !== 400 || multipartPayload.code !== 'CURRENT_UPLOAD_ENTRYPOINT_UPGRADED') {
      fail(`multipart branch must return upgrade JSON, got ${multipartResponse.status}: ${JSON.stringify(multipartPayload)}`);
    }

    const images = await prisma.referenceImage.findMany({
      where: { album_id: albumId, status: 'active' },
      orderBy: { sort_order: 'asc' },
    });
    if (images.length !== 1) fail(`expected 1 reference image, got ${images.length}`);
    const image = images[0];
    if (image.asset_id !== assetId) fail(`reference image asset_id=${image.asset_id}, expected ${assetId}`);
    if (image.url !== originalUrl) fail(`reference image url=${image.url}, expected ${originalUrl}`);
    if (image.thumbnail_url !== thumbnailUrl) {
      fail(`reference image thumbnail_url=${image.thumbnail_url}, expected ${thumbnailUrl}`);
    }
    const sameHashAssets = await prisma.asset.findMany({
      where: { hash },
      select: { id: true, owner_id: true },
    });
    if (sameHashAssets.length !== 1) fail(`expected JSON attach to avoid creating extra Asset rows, got ${sameHashAssets.length}`);
    const metadata = image.metadata_json ? JSON.parse(image.metadata_json) : {};
    if (metadata.source !== 'album_asset_upload_integration') {
      fail(`metadata.source mismatch: ${image.metadata_json || '(empty)'}`);
    }

    console.log('reference-album-duplicate-upload-integration: ok');
  } finally {
    await prisma.operationLog.deleteMany({ where: { target_id: albumId } });
    await prisma.referenceImage.deleteMany({ where: { album_id: albumId } });
    await prisma.referenceAlbum.deleteMany({ where: { id: albumId } });
    await prisma.asset.deleteMany({ where: { hash } });
    await prisma.user.deleteMany({ where: { id: uploaderId } });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  await prisma.$disconnect();
  console.error(error);
  process.exit(1);
});
