import crypto from 'node:crypto';
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';
import { uploadSiteAsset } from '../../src/lib/assets/site-upload';
import { addAssetToWorkspace, getOrCreateWorkspace } from '../../src/lib/assets/workspace';
import { attachAssetToSiteReferenceImage } from '../../src/lib/assets/reference-import';

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();

function fail(message: string): never {
  throw new Error(message);
}

async function main() {
  const runId = `workspace_dup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const existingOwnerId = `smoke_existing_${runId}`;
  const uploaderId = `smoke_uploader_${runId}`;
  const assetId = `smoke_asset_${runId}`;
  const content = Buffer.from(`workspace-duplicate-upload:${runId}`);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const originalUrl = `https://example.invalid/workspace/${runId}.png`;
  const thumbnailUrl = `https://example.invalid/workspace/${runId}_thumb.png`;

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
    if (!result.reused) fail('expected duplicate upload to be marked reused');
    if (result.assetId === assetId) fail('expected uploader-owned Asset id, got original owner id');
    if (result.originalUrl !== originalUrl) fail(`expected reused originalUrl ${originalUrl}, got ${result.originalUrl}`);

    const uploaderAsset = await prisma.asset.findFirst({
      where: { id: result.assetId, owner_id: uploaderId, hash, status: 'active' },
    });
    if (!uploaderAsset) fail('expected active uploader-owned Asset row');

    const historyCount = await prisma.asset.count({
      where: { owner_id: uploaderId, type: 'image', status: 'active', hash },
    });
    if (historyCount !== 1) fail(`expected uploader history to include one duplicate asset, got ${historyCount}`);

    const { id: workspaceId } = await getOrCreateWorkspace(`smoke:${runId}`, uploaderId);
    const workspaceAssetId = await addAssetToWorkspace(workspaceId, result.assetId, 'reference_image', uploaderId);
    if (!workspaceAssetId) fail('expected workspace asset id');

    const reference = await attachAssetToSiteReferenceImage({
      user: {
        id: uploaderId,
        name: 'Smoke Uploader',
        username: `${runId}_uploader`,
        email: `${runId}_uploader@example.invalid`,
        role: 'user',
        account_type: 'internal',
        user_profile: 'standard',
        feature_profile_id: null,
        status: 'active',
        expires_at: null,
      },
      workspaceId,
      sourceLabel: 'Smoke',
      role: 'reference_image',
      albumName: `Smoke 工作台重复上传 ${runId}`,
      albumDescription: '工作台重复上传 smoke',
      metadataSource: 'workspace_duplicate_upload_smoke',
    }, result.assetId);
    if (reference.assetId !== result.assetId) fail('expected reference to use uploader-owned asset');

    const sameHashAssets = await prisma.asset.count({ where: { hash } });
    if (sameHashAssets !== 2) fail(`expected two per-user Asset rows, got ${sameHashAssets}`);

    console.log('workspace-duplicate-upload-smoke: ok');
  } finally {
    await prisma.workspaceAsset.deleteMany({ where: { asset_id: { in: [assetId] } } });
    await prisma.referenceImage.deleteMany({ where: { asset_id: { in: [assetId] } } });
    await prisma.referenceAlbum.deleteMany({ where: { name: { startsWith: `Smoke 工作台重复上传 ${runId}` } } });
    await prisma.asset.deleteMany({ where: { hash } });
    await prisma.workspace.deleteMany({ where: { owner_id: uploaderId } });
    await prisma.user.deleteMany({ where: { id: { in: [existingOwnerId, uploaderId] } } });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  await prisma.$disconnect();
  console.error(error);
  process.exit(1);
});
