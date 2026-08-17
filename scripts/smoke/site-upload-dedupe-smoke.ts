import crypto from 'node:crypto';
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';
import { uploadSiteAsset } from '../../src/lib/assets/site-upload';

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();

function fail(message: string): never {
  throw new Error(message);
}

async function main() {
  const runId = `site_dup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const existingOwnerId = `smoke_existing_${runId}`;
  const uploaderId = `smoke_uploader_${runId}`;
  const assetId = `smoke_asset_${runId}`;
  const content = Buffer.from(`site-upload-dedupe:${runId}`);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const originalUrl = `https://example.invalid/assets/${runId}.png`;
  const thumbnailUrl = `https://example.invalid/assets/${runId}_thumb.png`;

  try {
    await prisma.user.create({
      data: {
        id: existingOwnerId,
        name: 'Smoke Existing Owner',
        username: `${runId}_existing`,
        email: `${runId}_existing@example.invalid`,
        password_hash: 'smoke-only',
        role: 'user',
        account_type: 'internal',
        status: 'active',
      },
    });
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
        owner_id: existingOwnerId,
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

    const result = await uploadSiteAsset(content, `${runId}.png`, 'image/png', content.length, uploaderId);

    if (result.assetId === assetId) fail('expected uploader to get their own Asset row, got original owner row');
    if (result.originalUrl !== originalUrl) fail(`expected originalUrl ${originalUrl}, got ${result.originalUrl}`);
    if (result.thumbnailUrl !== thumbnailUrl) fail(`expected thumbnailUrl ${thumbnailUrl}, got ${result.thumbnailUrl}`);
    if (result.reused !== true) fail('expected uploadSiteAsset to mark duplicate upload as reused');
    if (result.isPubliclyReachable !== true) fail('expected reused https URL to be publicly reachable');

    const sameHashAssets = await prisma.asset.findMany({
      where: { hash },
      select: { id: true, owner_id: true, original_url: true },
      orderBy: { owner_id: 'asc' },
    });
    if (sameHashAssets.length !== 2) fail(`expected two per-user Asset rows for hash, got ${sameHashAssets.length}`);
    const uploaderAsset = sameHashAssets.find((asset) => asset.owner_id === uploaderId);
    if (!uploaderAsset) {
      fail(`expected uploader-owned Asset row for ${uploaderId}`);
    }
    if (uploaderAsset.id !== result.assetId) {
      fail(`expected result asset ${result.assetId} to belong to uploader, got ${uploaderAsset.id}`);
    }
    if (uploaderAsset.original_url !== originalUrl) {
      fail(`expected uploader Asset to reuse originalUrl ${originalUrl}, got ${uploaderAsset.original_url}`);
    }

    console.log('site-upload-dedupe-smoke: ok');
  } finally {
    await prisma.asset.deleteMany({ where: { hash } });
    await prisma.user.deleteMany({ where: { id: { in: [existingOwnerId, uploaderId] } } });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  await prisma.$disconnect();
  console.error(error);
  process.exit(1);
});
