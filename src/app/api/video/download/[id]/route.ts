import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { cacheTaskVideoToLocal } from '@/lib/video/local-cache';

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
