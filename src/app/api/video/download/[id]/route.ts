import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Readable } from 'stream';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { cacheTaskVideoToLocal } from '@/lib/video/local-cache';
import { enqueueVideoDeliveryJob } from '@/lib/video/delivery-queue';
import { isVideoDeliveryFastPathTask } from '@/lib/video/delivery-policy';
import { localPublicVideoPath } from '@/lib/video/thumbnail';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VIDEO_MIME_TYPE = 'video/mp4';

function downloadFileName(taskId: string) {
  return `seedance-${taskId}.mp4`;
}

function downloadHeaders(taskId: string, contentLength?: string | number | null) {
  const headers: Record<string, string> = {
    'Content-Type': VIDEO_MIME_TYPE,
    'Content-Disposition': `attachment; filename="${downloadFileName(taskId)}"`,
    'Cache-Control': 'no-store',
  };
  if (contentLength !== null && contentLength !== undefined && String(contentLength)) {
    headers['Content-Length'] = String(contentLength);
  }
  return headers;
}

function nodeStreamToWebReadable(nodeStream: NodeJS.ReadableStream) {
  return Readable.toWeb(nodeStream as Readable) as ReadableStream<Uint8Array>;
}

async function loadAuthorizedTask(taskId: string) {
  const user = await getSession();
  if (!user) {
    return {
      error: NextResponse.json(
        { success: false, error: 'Unauthorized', message: '请先登录后再下载视频' },
        { status: 401 },
      ),
      task: null,
    };
  }

  const task = await prisma.videoTask.findUnique({
    where: { id: taskId },
  });

  if (!task) {
    return {
      error: NextResponse.json(
        { success: false, error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      ),
      task: null,
    };
  }

  try {
    await assertCanViewTask(user, task);
  } catch (error) {
    if (error instanceof AuthError) {
      return {
        error: NextResponse.json(
          { success: false, error: 'Forbidden', message: error.message },
          { status: error.status },
        ),
        task: null,
      };
    }
    throw error;
  }

  return { error: null, task };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  void request;
  const taskId = params.id;

  try {
    const { error, task } = await loadAuthorizedTask(taskId);
    if (error) return error;
    if (!task) {
      return NextResponse.json(
        { success: false, error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }

    if (task.public_video_url) {
      return NextResponse.redirect(task.public_video_url, 302);
    }

    const absolutePath = localPublicVideoPath(task.local_video_path);
    if (absolutePath) {
      let info;
      try {
        info = await stat(absolutePath);
      } catch {
        info = null;
      }
      if (info?.isFile() && info.size > 0) {
        return new NextResponse(nodeStreamToWebReadable(createReadStream(absolutePath)), {
          status: 200,
          headers: downloadHeaders(taskId, info.size),
        });
      }
    }

    return NextResponse.json(
      { success: false, error: 'Video not ready', message: '视频还没有可下载文件，请稍后刷新后重试。' },
      { status: 404 },
    );
  } catch (error) {
    console.error('[Download] GET Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Download failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/video/download/[id]
 * 
 * 从 result_video_url 下载视频到本地存储
 * 保存路径: public/videos/{task_id}.mp4
 * 更新数据库 local_video_path 字段
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const taskId = params.id;

  try {
    const { error, task } = await loadAuthorizedTask(taskId);
    if (error) return error;
    if (!task) {
      return NextResponse.json(
        { success: false, error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 },
      );
    }

    if (task.public_video_url) {
      return NextResponse.json({
        success: true,
        message: '稳定下载已就绪',
        public_video_url: task.public_video_url,
        stable_download_ready: true,
      });
    }

    if (task.local_status !== 'succeeded') {
      return NextResponse.json(
        { success: false, error: 'Task not completed', message: `Task status is ${task.local_status}` },
        { status: 400 }
      );
    }

    if (isVideoDeliveryFastPathTask(task) && !task.local_video_path) {
      const enqueueResult = await enqueueVideoDeliveryJob(task.id, {
        priority: 20,
        force: true,
        payload: { source: 'download_route' },
      });
      return NextResponse.json(
        {
          success: false,
          error: 'STABLE_DOWNLOAD_PREPARING',
          message: '视频已生成，系统正在准备稳定下载文件，请稍后重试。',
          delivery_queued: enqueueResult.queued,
          delivery_skipped_reason: enqueueResult.skippedReason ?? null,
          stable_download_ready: false,
        },
        { status: 202 },
      );
    }

    if (!task.result_video_url) {
      return NextResponse.json(
        { success: false, error: 'No video URL', message: 'Task has no result_video_url' },
        { status: 400 }
      );
    }

    const result = await cacheTaskVideoToLocal(task);
    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Download failed',
          message: result.message || '视频保存失败',
        },
        { status: result.status || 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: result.already_exists ? 'Video already downloaded' : 'Video downloaded successfully',
      local_video_path: result.local_video_path,
      file_size: result.file_size,
      already_exists: result.already_exists || false,
      refreshed_url: result.refreshed_url || false,
    });

  } catch (error) {
    console.error('[Download] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { 
        success: false,
        error: 'Download failed', 
        message: errorMessage,
      },
      { status: 500 }
    );
  }
}
