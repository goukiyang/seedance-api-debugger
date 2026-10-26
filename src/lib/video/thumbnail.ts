import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { mkdir, rename, stat, unlink } from 'fs/promises';
import { isPublicHttpUrl } from '@/lib/media/public-url';

const execFileAsync = promisify(execFile);
const PUBLIC_VIDEO_ROOT = path.join(process.cwd(), 'public');
const THUMBNAIL_DIR = path.join(PUBLIC_VIDEO_ROOT, 'videos', 'thumbnails');
const DEFAULT_FFMPEG_BIN = 'ffmpeg';
const THUMBNAIL_SEEK_SECONDS = ['2.5', '0.5'];

export type ThumbnailSourceTask = {
  id: string;
  public_video_url?: string | null;
  local_video_path: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
};

export type EnsureTaskThumbnailResult = {
  success: boolean;
  thumbnail_path?: string;
  source?: string;
  already_exists?: boolean;
  error?: string;
  message?: string;
};

export function isSafeTaskId(taskId: string) {
  return /^[a-z0-9_-]{8,80}$/i.test(taskId);
}

export async function fileExists(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export function thumbnailPublicPath(taskId: string) {
  return `/videos/thumbnails/${taskId}.jpg`;
}

export function thumbnailFilePath(taskId: string) {
  return path.join(THUMBNAIL_DIR, `${taskId}.jpg`);
}

export function localPublicVideoPath(localVideoPath: string | null) {
  if (!localVideoPath || !localVideoPath.startsWith('/videos/')) return null;
  if (localVideoPath.includes('..')) return null;
  return path.join(PUBLIC_VIDEO_ROOT, localVideoPath.slice(1));
}

export async function resolveThumbnailSources(
  task: Pick<ThumbnailSourceTask, 'public_video_url' | 'local_video_path' | 'result_video_url' | 'result_last_frame_url'>,
  options: { allowRemoteFallback?: boolean } = {},
) {
  const sources: string[] = [];
  const localVideo = localPublicVideoPath(task.local_video_path);
  if (localVideo && await fileExists(localVideo)) sources.push(localVideo);

  if (options.allowRemoteFallback !== false) {
    if (isPublicHttpUrl(task.public_video_url || null)) sources.push(task.public_video_url as string);
    if (isPublicHttpUrl(task.result_video_url)) sources.push(task.result_video_url as string);
    if (isPublicHttpUrl(task.result_last_frame_url)) sources.push(task.result_last_frame_url as string);
  }

  return sources;
}

async function generateThumbnailAtSeek(source: string, outputPath: string, seekSeconds: string) {
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.jpg`;
  try {
    await execFileAsync(process.env.FFMPEG_PATH || DEFAULT_FFMPEG_BIN, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      seekSeconds,
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

async function generateThumbnail(source: string, outputPath: string) {
  let lastError: unknown;
  for (const seekSeconds of THUMBNAIL_SEEK_SECONDS) {
    try {
      await generateThumbnailAtSeek(source, outputPath, seekSeconds);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function ensureTaskThumbnail(
  task: ThumbnailSourceTask,
  options: { allowRemoteFallback?: boolean } = {},
): Promise<EnsureTaskThumbnailResult> {
  if (!isSafeTaskId(task.id)) {
    return {
      success: false,
      error: 'Invalid task id',
      message: '任务 ID 无效',
    };
  }

  await mkdir(THUMBNAIL_DIR, { recursive: true });
  const thumbnailPath = thumbnailFilePath(task.id);
  if (await fileExists(thumbnailPath)) {
    return {
      success: true,
      thumbnail_path: thumbnailPublicPath(task.id),
      already_exists: true,
    };
  }

  const sources = await resolveThumbnailSources(task, options);
  if (sources.length === 0) {
    return {
      success: false,
      error: 'No thumbnail source',
      message: '没有可抽帧的视频',
    };
  }

  for (const source of sources) {
    try {
      await generateThumbnail(source, thumbnailPath);
      return {
        success: true,
        thumbnail_path: thumbnailPublicPath(task.id),
        source,
      };
    } catch (error) {
      await unlink(thumbnailPath).catch(() => undefined);
      console.warn('[VideoThumbnail] Source failed:', {
        taskId: task.id,
        localSource: !source.startsWith('http://') && !source.startsWith('https://'),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    success: false,
    error: 'Thumbnail generation failed',
    message: '视频截图不可用',
  };
}
