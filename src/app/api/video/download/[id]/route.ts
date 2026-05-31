import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { getVideoTaskStatus } from '@/lib/provider/jimeng';
import * as fs from 'fs';
import * as path from 'path';

const DOWNLOAD_TIMEOUT_MS = 60 * 1000; // 60秒超时

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
    const user = await getSession();
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized', message: '请先登录后再下载视频' },
        { status: 401 },
      );
    }

    // 1. 查询任务
    const task = await prisma.videoTask.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      return NextResponse.json(
        { success: false, error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 }
      );
    }

    try {
      await assertCanViewTask(user, task);
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json(
          { success: false, error: 'Forbidden', message: error.message },
          { status: error.status },
        );
      }
      throw error;
    }

    // 2. 检查是否有视频 URL
    if (!task.result_video_url) {
      return NextResponse.json(
        { success: false, error: 'No video URL', message: 'Task has no result_video_url' },
        { status: 400 }
      );
    }

    // 3. 检查是否已完成
    if (task.local_status !== 'succeeded') {
      return NextResponse.json(
        { success: false, error: 'Task not completed', message: `Task status is ${task.local_status}` },
        { status: 400 }
      );
    }

    // 保存到 public/videos 目录，Next.js 可直接访问
    const storageDir = path.join(process.cwd(), 'public', 'videos');
    const localFilePath = path.join(storageDir, `${taskId}.mp4`);
    const publicVideoPath = `/videos/${taskId}.mp4`;

    // 4. 检查本地文件是否已存在
    if (fs.existsSync(localFilePath)) {
      const fileSize = fs.statSync(localFilePath).size;
      if (task.local_video_path !== publicVideoPath) {
        await prisma.videoTask.update({
          where: { id: taskId },
          data: { local_video_path: publicVideoPath },
        });
      }
      return NextResponse.json({
        success: true,
        message: 'Video already downloaded',
        local_video_path: publicVideoPath,
        file_size: fileSize,
        already_exists: true,
      });
    }

    // 5. 确保存储目录存在
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    // 6. 流式下载视频（支持大文件 + 超时控制）
    let sourceVideoUrl = task.result_video_url;
    console.log(`[Download] Fetching video from: ${sourceVideoUrl}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchVideo(sourceVideoUrl, controller.signal);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        return NextResponse.json(
          { success: false, error: 'Download timeout', message: `下载超时（超过${DOWNLOAD_TIMEOUT_MS / 1000}秒），请重试或检查网络` },
          { status: 408 }
        );
      }
      throw fetchError;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 403 && task.provider_task_id) {
        const refreshed = await getVideoTaskStatus(task.provider_task_id);
        if (refreshed.result_video_url && refreshed.result_video_url !== sourceVideoUrl) {
          sourceVideoUrl = refreshed.result_video_url;
          await prisma.videoTask.update({
            where: { id: taskId },
            data: {
              result_video_url: sourceVideoUrl,
              result_last_frame_url: refreshed.result_last_frame_url || task.result_last_frame_url,
              raw_status_response: JSON.stringify(refreshed.raw),
            },
          });

          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(() => retryController.abort(), DOWNLOAD_TIMEOUT_MS);
          try {
            response = await fetchVideo(sourceVideoUrl, retryController.signal);
          } finally {
            clearTimeout(retryTimeoutId);
          }
        }
      }

      if (response.status === 403) {
        return NextResponse.json(
          {
            success: false,
            error: 'Signed URL expired',
            message: 'Provider 外链已过期或拒绝访问，且没有返回新的可用链接。请重新生成，或在任务完成后尽快保存到本地。',
          },
          { status: 410 },
        );
      }

      if (!response.ok) {
        return NextResponse.json(
          { success: false, error: 'Download failed', message: `下载失败: HTTP ${response.status}` },
          { status: 502 }
        );
      }
    }

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: 'Download failed', message: `下载失败: HTTP ${response.status}` },
        { status: 502 }
      );
    }

    const contentLength = response.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

    // 7. 流式写入文件（适合大文件）
    const fileStream = fs.createWriteStream(localFilePath);
    const reader = response.body?.getReader();
    
    if (!reader) {
      return NextResponse.json(
        { success: false, error: 'Stream error', message: '无法读取响应流' },
        { status: 500 }
      );
    }

    let receivedBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
        receivedBytes += value.length;
      }
    } finally {
      fileStream.end();
    }

    const fileSize = fs.statSync(localFilePath).size;

    // 8. 验证文件大小（如果已知）
    if (totalBytes > 0 && fileSize !== totalBytes) {
      console.warn(`[Download] Size mismatch: expected ${totalBytes}, got ${fileSize}`);
    }

    // 9. 更新数据库
    await prisma.videoTask.update({
      where: { id: taskId },
      data: { local_video_path: publicVideoPath },
    });

    console.log(`[Download] Video saved to: ${localFilePath}`);
    console.log(`[Download] File size: ${fileSize} bytes`);

    return NextResponse.json({
      success: true,
      message: 'Video downloaded successfully',
      local_video_path: publicVideoPath,
      file_size: fileSize,
      download_time_ms: Date.now(),
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
