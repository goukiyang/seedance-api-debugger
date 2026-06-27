import { createWriteStream } from 'fs';
import { mkdir, rename, stat, unlink } from 'fs/promises';
import path from 'path';
import { once } from 'events';
import { prisma } from '@/lib/prisma';
import { refreshProviderTaskResultUrl } from '@/lib/provider/video-task-status';

const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const PUBLIC_VIDEO_DIR = path.join(process.cwd(), 'public', 'videos');
const activeCacheTasks = new Map<string, Promise<LocalVideoCacheResult>>();

export type CacheableVideoTask = {
  id: string;
  provider?: string | null;
  local_status: string | null;
  provider_task_id: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
};

export type LocalVideoCacheResult = {
  success: boolean;
  local_video_path?: string;
  file_size?: number;
  already_exists?: boolean;
  refreshed_url?: boolean;
  result_video_url?: string;
  result_last_frame_url?: string | null;
  error?: string;
  message?: string;
  status?: number;
};

async function fileSizeIfExists(filePath: string) {
  try {
    const info = await stat(filePath);
    if (info.isFile() && info.size > 0) return info.size;
  } catch {
    return null;
  }
  return null;
}

function publicVideoPath(taskId: string) {
  return `/videos/${taskId}.mp4`;
}

function localVideoPath(taskId: string) {
  return path.join(PUBLIC_VIDEO_DIR, `${taskId}.mp4`);
}

async function fetchVideo(url: string, signal: AbortSignal) {
  return fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'video/mp4,*/*',
    },
    signal,
  });
}

async function fetchVideoWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchVideo(url, controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function writeResponseToFile(response: Response, targetPath: string, expectedBytes: number) {
  const body = response.body;
  if (!body) {
    throw new Error('无法读取视频响应流');
  }

  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const stream = createWriteStream(tempPath);
  const reader = body.getReader();
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      receivedBytes += value.length;
      if (!stream.write(Buffer.from(value))) {
        await once(stream, 'drain');
      }
    }

    stream.end();
    await once(stream, 'finish');

    const info = await stat(tempPath);
    if (!info.isFile() || info.size <= 0) {
      throw new Error('下载后的视频文件为空');
    }
    if (expectedBytes > 0 && info.size < expectedBytes) {
      throw new Error(`下载后的视频文件不完整: expected ${expectedBytes}, got ${info.size}`);
    }
    if (receivedBytes > 0 && info.size < receivedBytes) {
      throw new Error(`视频文件写入不完整: received ${receivedBytes}, got ${info.size}`);
    }

    await rename(tempPath, targetPath);
    return info.size;
  } catch (error) {
    stream.destroy();
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function updateTaskLocalPath(taskId: string, publicPath: string) {
  await prisma.videoTask.update({
    where: { id: taskId },
    data: { local_video_path: publicPath },
  });
}

async function refreshResultUrl(task: CacheableVideoTask) {
  const refreshed = await refreshProviderTaskResultUrl(task);
  if (!refreshed) return null;

  const updateData: {
    result_video_url: string;
    result_last_frame_url: string | null;
    raw_status_response?: string;
  } = {
    result_video_url: refreshed.result_video_url,
    result_last_frame_url: refreshed.result_last_frame_url,
  };
  if (refreshed.raw !== undefined) {
    updateData.raw_status_response = JSON.stringify(refreshed.raw);
  }

  await prisma.videoTask.update({ where: { id: task.id }, data: updateData });

  return {
    result_video_url: refreshed.result_video_url,
    result_last_frame_url: refreshed.result_last_frame_url,
  };
}

export async function cacheTaskVideoToLocal(
  task: CacheableVideoTask,
  options: { timeoutMs?: number; refreshOnForbidden?: boolean } = {},
): Promise<LocalVideoCacheResult> {
  const activeCacheTask = activeCacheTasks.get(task.id);
  if (activeCacheTask) return activeCacheTask;

  const cachePromise = cacheTaskVideoToLocalInner(task, options)
    .finally(() => {
      activeCacheTasks.delete(task.id);
    });
  activeCacheTasks.set(task.id, cachePromise);
  return cachePromise;
}

async function cacheTaskVideoToLocalInner(
  task: CacheableVideoTask,
  options: { timeoutMs?: number; refreshOnForbidden?: boolean } = {},
): Promise<LocalVideoCacheResult> {
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const refreshOnForbidden = options.refreshOnForbidden !== false;
  const publicPath = publicVideoPath(task.id);
  const targetPath = localVideoPath(task.id);

  const existingSize = await fileSizeIfExists(targetPath);
  if (existingSize) {
    if (task.local_video_path !== publicPath) {
      await updateTaskLocalPath(task.id, publicPath);
    }
    return {
      success: true,
      local_video_path: publicPath,
      file_size: existingSize,
      already_exists: true,
      result_video_url: task.result_video_url || undefined,
      result_last_frame_url: task.result_last_frame_url,
    };
  }

  if (task.local_status !== 'succeeded') {
    return {
      success: false,
      error: 'Task not completed',
      message: `Task status is ${task.local_status || 'unknown'}`,
      status: 400,
    };
  }

  if (!task.result_video_url) {
    return {
      success: false,
      error: 'No video URL',
      message: 'Task has no result_video_url',
      status: 400,
    };
  }

  await mkdir(PUBLIC_VIDEO_DIR, { recursive: true });

  let sourceUrl = task.result_video_url;
  let lastFrameUrl = task.result_last_frame_url;
  let refreshedUrl = false;
  let response: Response;

  try {
    response = await fetchVideoWithTimeout(sourceUrl, timeoutMs);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        error: 'Download timeout',
        message: `下载超时（超过${timeoutMs / 1000}秒），请重试或检查网络`,
        status: 408,
      };
    }
    throw error;
  }

  if (response.status === 403 && refreshOnForbidden) {
    const refreshed = await refreshResultUrl(task);
    if (refreshed?.result_video_url && refreshed.result_video_url !== sourceUrl) {
      sourceUrl = refreshed.result_video_url;
      lastFrameUrl = refreshed.result_last_frame_url;
      refreshedUrl = true;
      response = await fetchVideoWithTimeout(sourceUrl, timeoutMs);
    }
  }

  if (response.status === 403) {
    return {
      success: false,
      error: 'Signed URL expired',
      message: 'Provider 外链已过期或拒绝访问，且没有返回新的可用链接。',
      status: 410,
      refreshed_url: refreshedUrl,
    };
  }

  if (!response.ok) {
    return {
      success: false,
      error: 'Download failed',
      message: `下载失败: HTTP ${response.status}`,
      status: 502,
      refreshed_url: refreshedUrl,
    };
  }

  const contentLength = response.headers.get('content-length');
  const expectedBytes = contentLength ? Number.parseInt(contentLength, 10) : 0;
  const fileSize = await writeResponseToFile(
    response,
    targetPath,
    Number.isFinite(expectedBytes) ? expectedBytes : 0,
  );

  await updateTaskLocalPath(task.id, publicPath);

  return {
    success: true,
    local_video_path: publicPath,
    file_size: fileSize,
    refreshed_url: refreshedUrl,
    result_video_url: sourceUrl,
    result_last_frame_url: lastFrameUrl,
  };
}
