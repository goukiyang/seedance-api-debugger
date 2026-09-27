import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { AuthError, getSession, requireAuth, type SessionUser } from '@/lib/auth/session';

export class AnimationError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'INVALID_REQUEST',
    public readonly currentRevision?: number,
  ) {
    super(message);
  }
}

export function animationJson(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin) return;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AnimationError('请求来源无效', 403, 'ORIGIN_REJECTED');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new AnimationError('请求来源无效', 403, 'ORIGIN_REJECTED');
  }

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || request.headers.get('host') || request.nextUrl.host;
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto ? `${forwardedProto.replace(/:$/, '')}:` : request.nextUrl.protocol;
  if (!['http:', 'https:'].includes(protocol) || parsed.host.toLowerCase() !== host.toLowerCase() || parsed.protocol !== protocol) {
    throw new AnimationError('请求来源无效', 403, 'ORIGIN_REJECTED');
  }
}

export async function withAnimationAuth(
  request: NextRequest,
  write: boolean,
  action: (user: SessionUser) => Promise<NextResponse>,
) {
  try {
    if (write) sameOrigin(request);
    const user = await getSession();
    requireAuth(user);
    assertInternalOnly(user, '外部账号无权使用动画工作台。');
    const response = await action(user);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    const known = error instanceof AnimationError || error instanceof AuthError;
    const status = known ? error.status : 503;
    const code = error instanceof AnimationError
      ? error.code
      : error instanceof AuthError
        ? (status === 401 ? 'UNAUTHENTICATED' : status === 404 ? 'NOT_FOUND' : 'FORBIDDEN')
        : 'ANIMATION_UNAVAILABLE';
    const payload: { success: false; error: { code: string; message: string; current_revision?: number } } = {
      success: false,
      error: { code, message: known ? error.message : '动画服务暂时不可用，请稍后重试' },
    };
    if (error instanceof AnimationError && error.currentRevision !== undefined) {
      payload.error.current_revision = error.currentRevision;
    }
    return animationJson(payload, status);
  }
}

export async function readJsonBody(request: NextRequest, maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new AnimationError('请求内容格式无效', 415, 'UNSUPPORTED_MEDIA_TYPE');
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new AnimationError('请求内容过大', 413, 'BODY_TOO_LARGE');
  if (!request.body) throw new AnimationError('请求内容为空', 400, 'EMPTY_BODY');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AnimationError('请求内容过大', 413, 'BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch {
    throw new AnimationError('JSON 内容无效', 400, 'INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AnimationError('JSON 内容必须是对象', 400, 'INVALID_JSON');
  }
  return parsed as Record<string, unknown>;
}

export function requireRequestId(value: string | null) {
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new AnimationError('请求编号无效', 400, 'INVALID_REQUEST_ID');
  }
  return value;
}

export function requireMutationId(value: unknown) {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new AnimationError('操作编号无效', 400, 'INVALID_MUTATION_ID');
  }
  return value;
}

export function requireInteger(value: unknown, label: string, min = 0) {
  if (!Number.isInteger(value) || Number(value) < min) throw new AnimationError(`${label}无效`, 400, 'INVALID_REQUEST');
  return Number(value);
}

function parseRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const startRaw = match[1] ? Number(match[1]) : null;
  const endRaw = match[2] ? Number(match[2]) : null;
  if (startRaw === null) {
    if (!endRaw || endRaw <= 0) return null;
    return { start: Math.max(0, size - endRaw), end: size - 1 };
  }
  if (!Number.isSafeInteger(startRaw) || startRaw < 0 || startRaw >= size) return null;
  const end = endRaw === null ? size - 1 : Math.min(endRaw, size - 1);
  if (!Number.isSafeInteger(end) || end < startRaw) return null;
  return { start: startRaw, end };
}

function contentDisposition(name: string, download: boolean) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 160) || 'animation-file';
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function unsatisfiedRange(request: Request, size: number) {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Range': `bytes */${size}`,
  });
  if (request.method === 'HEAD') {
    headers.set('Content-Type', 'application/json');
    headers.set('Content-Length', '0');
    return new NextResponse(null, { status: 416, headers });
  }
  const response = animationJson({ success: false, error: { code: 'RANGE_NOT_SATISFIABLE', message: '请求范围无效' } }, 416);
  response.headers.set('Content-Range', `bytes */${size}`);
  response.headers.set('Accept-Ranges', 'bytes');
  return response;
}

export async function servePrivateAnimationFile(input: {
  request: Request;
  filePath: string;
  fileName: string;
  mime: string;
  expectedBytes: number;
  download?: boolean;
}) {
  const fileStat = await stat(input.filePath);
  if (!fileStat.isFile() || fileStat.size !== input.expectedBytes) throw new AnimationError('文件暂不可用', 404, 'NOT_FOUND');
  const baseHeaders = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Type': input.mime,
    'Content-Disposition': contentDisposition(input.fileName, input.download === true),
    'Content-Length': String(fileStat.size),
    'X-Content-Type-Options': 'nosniff',
  });
  const rangeHeader = input.request.headers.get('range');
  let start = 0;
  let end = fileStat.size - 1;
  let status = 200;
  if (rangeHeader) {
    if (rangeHeader.includes(',')) {
      return unsatisfiedRange(input.request, fileStat.size);
    }
    const range = parseRange(rangeHeader, fileStat.size);
    if (!range) {
      return unsatisfiedRange(input.request, fileStat.size);
    }
    start = range.start;
    end = range.end;
    status = 206;
    baseHeaders.set('Content-Length', String(end - start + 1));
    baseHeaders.set('Content-Range', `bytes ${start}-${end}/${fileStat.size}`);
  }
  if (input.request.method === 'HEAD') return new NextResponse(null, { status, headers: baseHeaders });
  const stream = Readable.toWeb(createReadStream(input.filePath, { start, end })) as ReadableStream<Uint8Array>;
  return new NextResponse(stream, { status, headers: baseHeaders });
}
