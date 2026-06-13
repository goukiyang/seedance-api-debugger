import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type PathParams = { path?: string[] };

function getCutoutServiceBase(): string {
  const raw = process.env.CUTOUT_SERVICE_BASE_URL || process.env.CUTOUT_BASE_URL || 'http://127.0.0.1:8098';
  if (/^https?:\/\//i.test(raw)) return raw.endsWith('/') ? raw.slice(0, -1) : raw;
  return `http://${raw}`;
}

function buildTargetUrl(path: string | undefined, request: NextRequest): string {
  const base = getCutoutServiceBase();
  const clean = path ? path.replace(/^\/+|\/+$/g, '') : '';
  if (clean === 'health') {
    return `${base}/health${request.nextUrl.search}`;
  }
  const suffix = clean ? `/api/integration/${clean}` : '/api/integration';
  return `${base}${suffix}${request.nextUrl.search}`;
}

function isJsonLike(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.includes('application/json') || contentType.includes('text/json') || contentType.includes('+json');
}

function safeJsonParse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractHtmlTitle(text: string): string | null {
  const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  return match[1].replace(/\s+/g, ' ').trim() || null;
}

function summarizeText(text: string, fallback: string): string {
  const title = extractHtmlTitle(text);
  const source = title || text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const plain = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!plain) return fallback;
  return plain.length > 180 ? `${plain.slice(0, 180)}...` : plain;
}

function upstreamErrorJson(upstream: Response, text: string, contentType: string | null) {
  const statusText = upstream.statusText || 'Bad Gateway';
  const summary = summarizeText(text, statusText);
  return NextResponse.json(
    {
      error: 'CUTOUT_UPSTREAM_ERROR',
      message: `抠图服务上游返回 ${upstream.status} ${statusText}`,
      upstreamStatus: upstream.status,
      upstreamContentType: contentType,
      detail: summary,
    },
    { status: upstream.status >= 400 ? upstream.status : 502 },
  );
}

function rewriteSingleUrl(value: string, serviceBase: string): string {
  try {
    const absolute = new URL(value);
    if (absolute.pathname.startsWith('/api/integration/')) {
      return `/api/cutout/${absolute.pathname.replace(/^\/api\/integration\//, '')}${absolute.search}${absolute.hash}`;
    }
  } catch {
    // ignore
  }

  if (value.startsWith('/api/integration/')) {
    return `/api/cutout/${value.slice('/api/integration/'.length)}`;
  }

  const normalizedBase = serviceBase.endsWith('/') ? serviceBase.slice(0, -1) : serviceBase;
  if (value === normalizedBase) {
    return '/api/cutout';
  }

  if (value === `${normalizedBase}/health`) {
    return '/api/cutout/health';
  }

  if (value.startsWith(`${normalizedBase}/api/integration/`)) {
    const tail = value.slice(`${normalizedBase}/api/integration/`.length);
    return `/api/cutout/${tail}`;
  }

  return value;
}

function rewriteResponsePayload(value: unknown, serviceBase: string): unknown {
  if (typeof value === 'string') {
    return rewriteSingleUrl(value, serviceBase);
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteResponsePayload(item, serviceBase));
  }

  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      next[key] = rewriteResponsePayload(nested, serviceBase);
    }
    return next;
  }

  return value;
}

async function proxy(request: NextRequest, context: { params: PathParams }): Promise<NextResponse> {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const path = context.params.path?.join('/') || '';
  const serviceBase = getCutoutServiceBase();
  const targetUrl = buildTargetUrl(path, request);

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host') return;
    headers.set(key, value);
  });

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    (init as { duplex?: 'half' }).duplex = 'half';
  }

  try {
    const upstream = await fetch(targetUrl, init);

    const contentType = upstream.headers.get('content-type');

    if (isJsonLike(contentType)) {
      const text = await upstream.text();
      const payload = safeJsonParse(text);
      if (payload === null && text) {
        return NextResponse.json(
          {
            error: 'CUTOUT_UPSTREAM_INVALID_JSON',
            message: '抠图服务返回了无法解析的 JSON',
            detail: summarizeText(text, 'invalid json'),
          },
          { status: 502 },
        );
      }
      return NextResponse.json(rewriteResponsePayload(payload, serviceBase), {
        status: upstream.status,
      });
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return upstreamErrorJson(upstream, text, contentType);
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: new Headers(upstream.headers),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: '抠图服务不可达',
        message: error instanceof Error ? error.message : 'unknown proxy error',
      },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest, context: { params: PathParams }) {
  return proxy(request, context);
}

export async function POST(request: NextRequest, context: { params: PathParams }) {
  return proxy(request, context);
}

export async function PUT(request: NextRequest, context: { params: PathParams }) {
  return proxy(request, context);
}

export async function PATCH(request: NextRequest, context: { params: PathParams }) {
  return proxy(request, context);
}

export async function DELETE(request: NextRequest, context: { params: PathParams }) {
  return proxy(request, context);
}

export async function OPTIONS(request: NextRequest, context: { params: PathParams }) {
  return proxy(request, context);
}
