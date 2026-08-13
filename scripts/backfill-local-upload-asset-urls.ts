import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { resolveSitePublicBaseUrl } from '../src/lib/assets/site-url';

const DEFAULT_PUBLIC_BASE_URL = 'https://sd2.youdooart.com';

type Candidate = {
  id: string;
  fileName: string;
  originalUrl: string;
  thumbnailUrl: string | null;
  nextOriginalUrl: string;
  nextThumbnailUrl: string | null;
};

function normalizePublicBaseUrl() {
  const baseUrl = (resolveSitePublicBaseUrl() || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+/.test(baseUrl)) {
    throw new Error('NEXT_PUBLIC_BASE_URL 必须是公网 HTTPS 地址，不能用于回填本地或相对地址。');
  }
  return baseUrl;
}

function isLocalUploadUrl(value: string | null | undefined) {
  return Boolean(value && value.startsWith('/uploads/'));
}

function localUploadPath(url: string) {
  const publicRoot = path.resolve(process.cwd(), 'public');
  const resolved = path.resolve(publicRoot, url.replace(/^\/+/, ''));
  if (!resolved.startsWith(`${publicRoot}${path.sep}`)) {
    throw new Error(`本地上传路径非法: ${url}`);
  }
  return resolved;
}

function databasePathFromEnv() {
  const rawUrl = process.env.DATABASE_URL || 'file:./dev.db';
  if (!rawUrl.startsWith('file:')) return null;
  const withoutScheme = rawUrl.slice('file:'.length).split('?')[0] || './dev.db';
  if (path.isAbsolute(withoutScheme)) return withoutScheme;

  const fromPrismaDir = path.resolve(process.cwd(), 'prisma', withoutScheme);
  if (fs.existsSync(fromPrismaDir)) return fromPrismaDir;

  const fromRoot = path.resolve(process.cwd(), withoutScheme);
  if (fs.existsSync(fromRoot)) return fromRoot;
  return fromPrismaDir;
}

function backupSqliteDatabase() {
  const dbPath = databasePathFromEnv();
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error('SQLite 数据库文件未找到，停止执行，避免无备份写库。');
  }
  const dbStat = fs.statSync(dbPath);
  if (dbStat.size <= 0) {
    throw new Error(`SQLite 数据库文件大小异常，停止执行: ${dbPath}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(process.cwd(), 'storage', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupBasePath = path.join(backupDir, `${path.basename(dbPath)}.local-upload-url-backfill.${timestamp}.bak`);
  const copiedPaths: string[] = [];

  for (const sourcePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!fs.existsSync(sourcePath)) continue;
    const suffix = sourcePath === dbPath ? '' : path.basename(sourcePath).slice(path.basename(dbPath).length);
    const backupPath = `${backupBasePath}${suffix}`;
    fs.copyFileSync(sourcePath, backupPath);
    copiedPaths.push(backupPath);
  }

  if (copiedPaths.length === 0) {
    throw new Error('SQLite 数据库备份失败，未复制任何文件。');
  }
  console.log(`[backfill-local-upload-asset-urls] 已备份数据库: ${copiedPaths.join(', ')}`);
  return copiedPaths;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const publicBaseUrl = normalizePublicBaseUrl();
  const assets = await prisma.asset.findMany({
    where: {
      status: 'active',
      original_url: { startsWith: '/uploads/' },
    },
    select: {
      id: true,
      file_name: true,
      original_url: true,
      thumbnail_url: true,
    },
    orderBy: { created_at: 'asc' },
  });

  const candidates: Candidate[] = [];
  const skipped: Array<{ id: string; fileName: string; reason: string }> = [];

  for (const asset of assets) {
    try {
      const originalPath = localUploadPath(asset.original_url);
      if (!fs.existsSync(originalPath)) {
        skipped.push({ id: asset.id, fileName: asset.file_name, reason: '原始文件不存在' });
        continue;
      }

      let nextThumbnailUrl = asset.thumbnail_url;
      if (isLocalUploadUrl(asset.thumbnail_url)) {
        const thumbnailPath = localUploadPath(asset.thumbnail_url!);
        nextThumbnailUrl = fs.existsSync(thumbnailPath)
          ? `${publicBaseUrl}${asset.thumbnail_url}`
          : asset.thumbnail_url;
      }

      candidates.push({
        id: asset.id,
        fileName: asset.file_name,
        originalUrl: asset.original_url,
        thumbnailUrl: asset.thumbnail_url,
        nextOriginalUrl: `${publicBaseUrl}${asset.original_url}`,
        nextThumbnailUrl,
      });
    } catch (error) {
      skipped.push({
        id: asset.id,
        fileName: asset.file_name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(`[backfill-local-upload-asset-urls] mode=${execute ? 'execute' : 'dry-run'} candidates=${candidates.length} skipped=${skipped.length}`);
  for (const item of candidates.slice(0, 20)) {
    console.log(`- ${item.id} ${item.fileName}: ${item.originalUrl} -> ${item.nextOriginalUrl}`);
  }
  if (candidates.length > 20) {
    console.log(`- ... 还有 ${candidates.length - 20} 条未展开`);
  }
  for (const item of skipped.slice(0, 20)) {
    console.log(`! skip ${item.id} ${item.fileName}: ${item.reason}`);
  }

  if (!execute) {
    console.log('[backfill-local-upload-asset-urls] dry-run 完成；确认后可加 --execute 写入。');
    return;
  }

  backupSqliteDatabase();
  for (const item of candidates) {
    await prisma.asset.update({
      where: { id: item.id },
      data: {
        original_url: item.nextOriginalUrl,
        thumbnail_url: item.nextThumbnailUrl,
      },
    });
  }
  console.log(`[backfill-local-upload-asset-urls] 已回填 ${candidates.length} 条资产公网 URL。`);
}

main()
  .catch((error) => {
    console.error('[backfill-local-upload-asset-urls] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
