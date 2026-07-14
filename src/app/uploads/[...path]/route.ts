import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UPLOADS_ROOT = path.join(process.cwd(), 'public', 'uploads');

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function safeUploadPath(segments: string[]) {
  if (!segments.length) return null;
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) {
    return null;
  }

  const filePath = path.normalize(path.join(UPLOADS_ROOT, ...segments));
  const relativePath = path.relative(UPLOADS_ROOT, filePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
  return filePath;
}

function contentTypeFor(filePath: string) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function parseRange(header: string | null, fileSize: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const startStr = match[1];
  const endStr = match[2];
  if (startStr === '' && endStr === '') return null;

  let start: number;
  let end: number;
  if (startStr === '') {
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(fileSize - suffix, 0);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    if (!Number.isFinite(start) || start < 0) return null;
    end = endStr === '' ? fileSize - 1 : Number.parseInt(endStr, 10);
    if (!Number.isFinite(end) || end < start) return null;
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

async function uploadResponse(
  request: NextRequest,
  params: { path?: string[] },
  includeBody: boolean,
) {
  const filePath = safeUploadPath(params.path || []);
  if (!filePath) {
    return NextResponse.json({ error: '上传文件路径无效' }, { status: 400 });
  }

  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    fileInfo = null;
  }

  if (!fileInfo?.isFile() || fileInfo.size <= 0) {
    return NextResponse.json({ error: '上传文件不存在' }, { status: 404 });
  }

  const fileSize = fileInfo.size;
  const range = parseRange(request.headers.get('range'), fileSize);
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentTypeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };

  if (range) {
    const length = range.end - range.start + 1;
    return new NextResponse(
      includeBody ? nodeStreamToWebReadable(createReadStream(filePath, { start: range.start, end: range.end })) : null,
      {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
          'Content-Length': String(length),
        },
      },
    );
  }

  return new NextResponse(
    includeBody ? nodeStreamToWebReadable(createReadStream(filePath)) : null,
    {
      status: 200,
      headers: {
        ...baseHeaders,
        'Content-Length': String(fileSize),
      },
    },
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: { path?: string[] } },
) {
  return uploadResponse(request, params, true);
}

export async function HEAD(
  request: NextRequest,
  { params }: { params: { path?: string[] } },
) {
  return uploadResponse(request, params, false);
}
