import { stat } from 'fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { isSafeTaskId, localPublicVideoPath } from '@/lib/video/thumbnail';
import { mediaPreviewResponse } from '@/lib/media/preview-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MIME_TYPE = 'video/mp4';
const H3_INTERNAL_OUTPUT_SCHEME = 'h3-internal-output://';

function isInternalOnlyResultUrl(value: string | null | undefined) {
  return Boolean(value?.startsWith(H3_INTERNAL_OUTPUT_SCHEME));
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const taskId = params.id;
  if (!isSafeTaskId(taskId)) {
    return NextResponse.json({ error: '任务 ID 无效' }, { status: 400 });
  }
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: '未登录', message: '请先登录后再查看视频' }, { status: 401 });
  }

  const task = await prisma.videoTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      public_video_url: true,
      local_video_path: true,
      result_video_url: true,
      project_id: true,
      owner_user_id: true,
      user_id: true,
      retention_status: true,
    },
  });

  if (!task) {
    return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  }
  try {
    await assertCanViewTask(user, task);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: '权限不足', message: error.message }, { status: error.status });
    }
    throw error;
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
      return mediaPreviewResponse(request, task.local_video_path!, MIME_TYPE);
    }
  }

  if (isInternalOnlyResultUrl(task.result_video_url)) {
    return NextResponse.json({ error: 'H3 输出正在缓存，刷新后再试' }, { status: 425 });
  }

  if (task.result_video_url) {
    return NextResponse.redirect(task.result_video_url, 302);
  }

  return NextResponse.json({ error: '本地视频未就绪且没有可用的 Provider 链接' }, { status: 404 });
}

export const HEAD = GET;
