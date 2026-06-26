import { readFile } from 'fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import {
  ensureTaskThumbnail,
  isSafeTaskId,
  thumbnailFilePath,
} from '@/lib/video/thumbnail';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

    const task = await prisma.videoTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        local_video_path: true,
        result_video_url: true,
        result_last_frame_url: true,
        local_status: true,
        provider_task_id: true,
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

    const thumbnailResult = await ensureTaskThumbnail({
      ...task,
      // 浏览缩略图不能触发远程 mp4 拉取；无本地视频时只允许尾帧图片作为远程兜底。
      result_video_url: null,
    }, { allowRemoteFallback: true });
    if (!thumbnailResult.success) {
      return NextResponse.json({ error: thumbnailResult.message || '视频截图不可用' }, { status: 404 });
    }

    return imageResponse(thumbnailFilePath(taskId));
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[VideoThumbnail] Failed to generate thumbnail:', error);
    return NextResponse.json({ error: '生成视频截图失败' }, { status: 500 });
  }
}
