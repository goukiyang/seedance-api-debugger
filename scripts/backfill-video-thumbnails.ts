import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { siteUploadPathFromUrl } from '../src/lib/assets/site-url';
import { generateAssetVideoThumbnail } from '../src/lib/assets/video-thumbnail';
import { ensureTaskThumbnail, fileExists, thumbnailFilePath } from '../src/lib/video/thumbnail';

type BackfillMode = 'dry-run' | 'execute';

function parseMode(): BackfillMode {
  return process.argv.includes('--execute') || process.argv.includes('--apply') ? 'execute' : 'dry-run';
}

function parseLimit() {
  const raw = process.argv.find((item) => item.startsWith('--limit='))?.split('=')[1];
  const limit = raw ? Number.parseInt(raw, 10) : 200;
  return Number.isFinite(limit) && limit > 0 ? limit : 200;
}

function parseMaxCandidates() {
  const raw = process.argv.find((item) => item.startsWith('--max-candidates='))?.split('=')[1];
  if (!raw) return null;
  const maxCandidates = Number.parseInt(raw, 10);
  return Number.isFinite(maxCandidates) && maxCandidates > 0 ? maxCandidates : null;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function shouldBackfillTasks() {
  return !hasFlag('--assets-only');
}

function shouldBackfillAssets() {
  return !hasFlag('--tasks-only');
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(process.cwd(), 'storage', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupBasePath = path.join(backupDir, `${path.basename(dbPath)}.video-thumbnail-backfill.${timestamp}.bak`);
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
  console.log(`[backfill-video-thumbnails] 已备份数据库: ${copiedPaths.join(', ')}`);
}

function localUploadPathFromUrl(url: string | null | undefined) {
  const localUrl = siteUploadPathFromUrl(url || null);
  if (!localUrl) return null;
  const publicRoot = path.resolve(process.cwd(), 'public');
  const resolvedPath = path.resolve(publicRoot, localUrl.replace(/^\/+/, ''));
  if (!resolvedPath.startsWith(`${publicRoot}${path.sep}`)) {
    throw new Error(`本地上传路径非法: ${url}`);
  }
  return resolvedPath;
}

async function assetThumbnailExists(thumbnailUrl: string | null) {
  if (!thumbnailUrl) return false;
  const localPath = localUploadPathFromUrl(thumbnailUrl);
  if (!localPath) return true;
  return fs.existsSync(localPath) && fs.statSync(localPath).isFile();
}

async function backfillTaskThumbnails(mode: BackfillMode, limit: number, maxCandidates: number | null) {
  const tasks = await prisma.videoTask.findMany({
    where: {
      local_status: 'succeeded',
      OR: [
        { local_video_path: { not: null } },
        { public_video_url: { not: null } },
        { result_video_url: { not: null } },
        { result_last_frame_url: { not: null } },
      ],
    },
    select: {
      id: true,
      public_video_url: true,
      local_video_path: true,
      result_video_url: true,
      result_last_frame_url: true,
    },
    orderBy: { created_at: 'desc' },
    take: limit,
  });

  let candidateCount = 0;
  let generatedCount = 0;
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const task of tasks) {
    if (await fileExists(thumbnailFilePath(task.id))) continue;
    if (maxCandidates !== null && candidateCount >= maxCandidates) break;
    candidateCount += 1;
    if (mode === 'dry-run') {
      console.log(`- task ${task.id}: 可补任务截图`);
      continue;
    }

    const result = await ensureTaskThumbnail(task, { allowRemoteFallback: true });
    if (result.success) {
      generatedCount += 1;
    } else {
      skipped.push({ id: task.id, reason: result.message || result.error || '截图生成失败' });
    }
    if (candidateCount % 10 === 0) {
      console.log(`[backfill-video-thumbnails] tasks progress candidates=${candidateCount} generated=${generatedCount} skipped=${skipped.length}`);
    }
  }

  return { scanned: tasks.length, candidateCount, generatedCount, skipped };
}

async function backfillAssetThumbnails(mode: BackfillMode, limit: number, maxCandidates: number | null) {
  const assets = await prisma.asset.findMany({
    where: {
      type: 'video',
      status: { not: 'deleted' },
    },
    select: {
      id: true,
      original_url: true,
      thumbnail_url: true,
      hash: true,
      file_name: true,
    },
    orderBy: { created_at: 'desc' },
    take: limit,
  });

  let candidateCount = 0;
  let generatedCount = 0;
  const skipped: Array<{ id: string; fileName: string; reason: string }> = [];

  for (const asset of assets) {
    if (await assetThumbnailExists(asset.thumbnail_url)) continue;

    const sourcePath = localUploadPathFromUrl(asset.original_url);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      skipped.push({ id: asset.id, fileName: asset.file_name, reason: '原视频文件不是本站本地上传，或本地文件不存在' });
      continue;
    }

    if (maxCandidates !== null && candidateCount >= maxCandidates) break;
    candidateCount += 1;
    if (mode === 'dry-run') {
      console.log(`- asset ${asset.id} ${asset.file_name}: 可补视频封面`);
      continue;
    }

    const result = await generateAssetVideoThumbnail({
      sourcePath,
      outputDir: path.resolve(process.cwd(), 'public', 'uploads', 'thumbs'),
      outputName: asset.hash || asset.id,
    });
    if (!result.success || !result.thumbnailPath) {
      skipped.push({ id: asset.id, fileName: asset.file_name, reason: result.message || result.error || '封面生成失败' });
      continue;
    }

    await prisma.asset.update({
      where: { id: asset.id },
      data: { thumbnail_url: `/uploads/thumbs/${path.basename(result.thumbnailPath)}` },
    });
    generatedCount += 1;
    if (candidateCount % 10 === 0) {
      console.log(`[backfill-video-thumbnails] assets progress candidates=${candidateCount} generated=${generatedCount} skipped=${skipped.length}`);
    }
  }

  return { scanned: assets.length, candidateCount, generatedCount, skipped };
}

async function main() {
  const mode = parseMode();
  const limit = parseLimit();
  const maxCandidates = parseMaxCandidates();
  const runTasks = shouldBackfillTasks();
  const runAssets = shouldBackfillAssets();
  if (!runTasks && !runAssets) {
    throw new Error('不能同时跳过任务和素材缩略图补偿。');
  }
  console.log(`[backfill-video-thumbnails] mode=${mode} limit=${limit} maxCandidates=${maxCandidates ?? 'all'} tasks=${runTasks} assets=${runAssets}`);
  if (mode === 'execute' && runAssets) backupSqliteDatabase();

  const taskResult = runTasks
    ? await backfillTaskThumbnails(mode, limit, maxCandidates)
    : { scanned: 0, candidateCount: 0, generatedCount: 0, skipped: [] as Array<{ id: string; reason: string }> };
  const assetResult = runAssets
    ? await backfillAssetThumbnails(mode, limit, maxCandidates)
    : { scanned: 0, candidateCount: 0, generatedCount: 0, skipped: [] as Array<{ id: string; fileName: string; reason: string }> };

  console.log(`[backfill-video-thumbnails] tasks scanned=${taskResult.scanned} candidates=${taskResult.candidateCount} generated=${taskResult.generatedCount} skipped=${taskResult.skipped.length}`);
  console.log(`[backfill-video-thumbnails] assets scanned=${assetResult.scanned} candidates=${assetResult.candidateCount} generated=${assetResult.generatedCount} skipped=${assetResult.skipped.length}`);

  for (const item of taskResult.skipped.slice(0, 20)) {
    console.log(`! task ${item.id}: ${item.reason}`);
  }
  for (const item of assetResult.skipped.slice(0, 20)) {
    console.log(`! asset ${item.id} ${item.fileName}: ${item.reason}`);
  }
  if (mode === 'dry-run') {
    console.log('[backfill-video-thumbnails] dry-run 完成；确认后可加 --execute 写入。');
  }
}

main()
  .catch((error) => {
    console.error('[backfill-video-thumbnails] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
