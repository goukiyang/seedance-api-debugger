import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { mkdir, readFile, rename, stat, unlink } from 'fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);
const THUMBNAIL_DIR = path.join(process.cwd(), 'public', 'videos', 'thumbnails');
const PUBLIC_VIDEO_ROOT = path.join(process.cwd(), 'public');
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

function isSafeTaskId(taskId: string) {
  return /^[a-z0-9_-]{8,80}$/i.test(taskId);
}

async function fileExists(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function localPublicVideoPath(localVideoPath: string | null) {
  if (!localVideoPath || !localVideoPath.startsWith('/videos/')) return null;
  if (localVideoPath.includes('..')) return null;
  return path.join(PUBLIC_VIDEO_ROOT, localVideoPath.slice(1));
}

function isRemoteAssetUrl(value: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function resolveThumbnailSources(task: {
  local_video_path: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
}) {
  const sources: string[] = [];
  const localVideo = localPublicVideoPath(task.local_video_path);
  if (localVideo && await fileExists(localVideo)) sources.push(localVideo);
  if (isRemoteAssetUrl(task.result_video_url)) sources.push(task.result_video_url as string);
  if (isRemoteAssetUrl(task.result_last_frame_url)) sources.push(task.result_last_frame_url as string);
  return sources;
}

async function generateThumbnail(source: string, outputPath: string) {
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.jpg`;
  try {
    await execFileAsync(FFMPEG_BIN, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '0.5',
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      'scale=360:-2',
      '-q:v',
      '4',
      tempPath,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function imageResponse(filePath: string) {
  const file = await readFile(filePath);
  return new NextResponse(file, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const taskId = params.id;
    if (!isSafeTaskId(taskId)) {
      return NextResponse.json({ error: '任务 ID 无效' }, { status: 400 });
    }

    await mkdir(THUMBNAIL_DIR, { recursive: true });
    const thumbnailPath = path.join(THUMBNAIL_DIR, `${taskId}.jpg`);
    if (await fileExists(thumbnailPath)) {
      return imageResponse(thumbnailPath);
    }

    const task = await prisma.videoTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        local_video_path: true,
        result_video_url: true,
        result_last_frame_url: true,
        project_id: true,
        owner_user_id: true,
        user_id: true,
        retention_status: true,
      },
    });

    if (!task) {
      return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    }

    await assertCanViewTask(user, task);

    const sources = await resolveThumbnailSources(task);
    if (sources.length === 0) {
      return NextResponse.json({ error: '没有可抽帧的视频' }, { status: 404 });
    }

    for (const source of sources) {
      try {
        await generateThumbnail(source, thumbnailPath);
        return imageResponse(thumbnailPath);
      } catch {
        await unlink(thumbnailPath).catch(() => undefined);
      }
    }

    return NextResponse.json({ error: '视频截图不可用' }, { status: 404 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[VideoThumbnail] Failed to generate thumbnail:', error);
    return NextResponse.json({ error: '生成视频截图失败' }, { status: 500 });
  }
}
