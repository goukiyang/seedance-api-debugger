import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isSafeTaskId, localPublicVideoPath } from '@/lib/video/thumbnail';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MIME_TYPE = 'video/mp4';

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

  const task = await prisma.videoTask.findUnique({
    where: { id: taskId },
    select: { local_video_path: true },
  });

  if (!task) {
    return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  }

  const absolutePath = localPublicVideoPath(task.local_video_path);
  if (!absolutePath) {
    return NextResponse.json({ error: '本地视频未就绪' }, { status: 404 });
  }

  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    return NextResponse.json({ error: '本地视频文件不存在' }, { status: 404 });
  }
  if (!info.isFile() || info.size <= 0) {
    return NextResponse.json({ error: '本地视频文件为空' }, { status: 404 });
  }

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
