import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { isSafeTaskId, localPublicVideoPath } from '@/lib/video/thumbnail';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MIME_TYPE = 'video/mp4';
const H3_INTERNAL_OUTPUT_SCHEME = 'h3-internal-output://';

function isInternalOnlyResultUrl(value: string | null | undefined) {
  return Boolean(value?.startsWith(H3_INTERNAL_OUTPUT_SCHEME));
}

function parseRange(header: string | null, fileSize: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startStr = match[1];
  const endStr = match[2];
  let start: number;
  let end: number;
  if (startStr === '' && endStr === '') return null;
  if (startStr === '') {
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(fileSize - suffix, 0);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    if (!Number.isFinite(start) || start < 0) return null;
    if (endStr === '') {
      end = fileSize - 1;
    } else {
      end = Number.parseInt(endStr, 10);
      if (!Number.isFinite(end) || end < start) return null;
    }
  }
  if (start >= fileSize) return null;
  if (end >= fileSize) end = fileSize - 1;
  return { start, end };
}

function nodeStreamToWebReadable(nodeStream: NodeJS.ReadableStream) {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => {
        controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    cancel() {
      (nodeStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    },
  });
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
      const fileSize = info.size;
      const range = parseRange(request.headers.get('range'), fileSize);
      const baseHeaders: Record<string, string> = {
        'Content-Type': MIME_TYPE,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=0, must-revalidate',
      };

      if (range) {
        const length = range.end - range.start + 1;
        const stream = createReadStream(absolutePath, { start: range.start, end: range.end });
        return new NextResponse(nodeStreamToWebReadable(stream), {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
            'Content-Length': String(length),
          },
        });
      }

      const stream = createReadStream(absolutePath);
      return new NextResponse(nodeStreamToWebReadable(stream), {
        status: 200,
        headers: {
          ...baseHeaders,
          'Content-Length': String(fileSize),
        },
      });
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
