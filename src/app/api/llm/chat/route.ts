import { NextRequest, NextResponse } from 'next/server';
import { getSession, AuthError } from '@/lib/auth/session';
import {
  createMuskChatCompletion,
  getMuskApiSettings,
  isMuskApiReady,
  MuskApiError,
  openMuskChatStream,
  resolveMuskChatModels,
  type MuskChatContentPart,
  type MuskChatMessage,
} from '@/lib/integrations/musk';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 24000;
const MAX_IMAGES_PER_MESSAGE = 6;
const MAX_IMAGE_URL_CHARS = 2048;

type IncomingImage = {
  id?: string;
  url: string;
};

type IncomingMessage = {
  role: string;
  content: string;
  images?: IncomingImage[];
};

function asTrimmedString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeImageUrl(raw: string) {
  const url = raw.trim();
  if (!url || url.length > MAX_IMAGE_URL_CHARS) return null;
  if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('/')) {
    return url;
  }
  return null;
}

function toAbsoluteSd2Url(url: string) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  // relative asset paths from SD2 history/library
  return `https://sd2.youdooart.com${url.startsWith('/') ? url : `/${url}`}`;
}

function parseIncomingMessages(body: unknown): { messages: IncomingMessage[]; temperature?: number; model?: string; stream: boolean } {
  if (!body || typeof body !== 'object') {
    throw new AuthError('请求体无效', 400);
  }
  const payload = body as Record<string, unknown>;
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new AuthError('messages 不能为空', 400);
  }
  if (payload.messages.length > MAX_MESSAGES) {
    throw new AuthError(`messages 最多 ${MAX_MESSAGES} 条`, 400);
  }

  const messages: IncomingMessage[] = [];
  let totalChars = 0;

  for (const item of payload.messages) {
    if (!item || typeof item !== 'object') {
      throw new AuthError('messages 条目无效', 400);
    }
    const row = item as Record<string, unknown>;
    const role = asTrimmedString(row.role);
    const content = asTrimmedString(row.content);
    if (!ALLOWED_ROLES.has(role)) {
      throw new AuthError('messages.role 非法', 400);
    }
    if (!content) {
      throw new AuthError('messages.content 不能为空', 400);
    }
    totalChars += content.length;
    if (totalChars > MAX_CONTENT_CHARS) {
      throw new AuthError('messages 总长度超限', 400);
    }

    const images: IncomingImage[] = [];
    if (Array.isArray(row.images)) {
      if (row.images.length > MAX_IMAGES_PER_MESSAGE) {
        throw new AuthError(`单条消息最多附带 ${MAX_IMAGES_PER_MESSAGE} 张图`, 400);
      }
      for (const img of row.images) {
        if (!img || typeof img !== 'object') continue;
        const image = img as Record<string, unknown>;
        const url = normalizeImageUrl(asTrimmedString(image.url));
        if (!url) continue;
        images.push({
          id: asTrimmedString(image.id) || undefined,
          url: toAbsoluteSd2Url(url),
        });
      }
    }

    messages.push({
      role,
      content,
      images: images.length ? images : undefined,
    });
  }

  let temperature: number | undefined;
  if (payload.temperature !== undefined && payload.temperature !== null) {
    const t = Number(payload.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) {
      throw new AuthError('temperature 需在 0–2 之间', 400);
    }
    temperature = t;
  }

  const model = asTrimmedString(payload.model).slice(0, 80) || undefined;
  return { messages, temperature, model, stream: payload.stream === true };
}

function toMuskMessages(messages: IncomingMessage[]): MuskChatMessage[] {
  return messages.map((msg) => {
    const role = msg.role as MuskChatMessage['role'];
    const images = msg.images || [];
    if (images.length === 0) {
      return { role, content: msg.content };
    }

    // 多模态优先：OpenAI 兼容 image_url parts
    const parts: MuskChatContentPart[] = [
      { type: 'text', text: msg.content },
      ...images.map((img) => ({
        type: 'image_url' as const,
        image_url: { url: img.url },
      })),
    ];

    // 文本兜底：若上游不吃 vision，至少把 URL 写进同条文本（多数兼容层仍读 text part）
    const urlLines = images
      .map((img, idx) => `- image${idx + 1}${img.id ? ` (id=${img.id})` : ''}: ${img.url}`)
      .join('\n');
    parts[0] = {
      type: 'text',
      text: `${msg.content}\n\n[Attached image URLs]\n${urlLines}`,
    };

    return { role, content: parts };
  });
}

/** 把上游 OpenAI SSE 转成 `data: {"delta":"..."}`，结尾 `event: done`。 */
function toDeltaSse(upstream: Response, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body!.getReader();
  let buffer = '';
  let upstreamModel: string | null = null;
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, obj: unknown, event?: string) => {
    controller.enqueue(encoder.encode(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`));
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          send(controller, { done: true, model: upstreamModel || model }, 'done');
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const json = JSON.parse(data) as { model?: unknown; choices?: Array<{ delta?: { content?: unknown } }> };
            if (typeof json.model === 'string') upstreamModel = json.model;
            const delta = json.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) send(controller, { delta });
          } catch {
            // 忽略非 JSON 行
          }
        }
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        send(controller, { error: aborted ? '请求已取消' : '流式读取失败' }, 'error');
        controller.close();
      }
    },
    cancel() {
      void reader.cancel();
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'JSON 解析失败', ok: false }, { status: 400 });
    }

    const { messages, temperature, model: requestedModel, stream } = parseIncomingMessages(body);
    const settings = await getMuskApiSettings();
    if (!isMuskApiReady(settings)) {
      return NextResponse.json(
        { error: 'Musk API 未启用或缺少配置', ok: false, code: 'musk_api_not_configured' },
        { status: 503 },
      );
    }

    let model = settings.default_model;
    if (requestedModel && requestedModel !== settings.default_model) {
      const allowed = await resolveMuskChatModels(settings);
      if (!allowed.includes(requestedModel)) {
        return NextResponse.json({ error: '模型不在可用名单内', ok: false, code: 'model_not_allowed' }, { status: 400 });
      }
      model = requestedModel;
    }

    if (stream) {
      const upstream = await openMuskChatStream({
        settings,
        messages: toMuskMessages(messages),
        temperature: temperature ?? 0.4,
        model,
        signal: request.signal,
      });
      return new Response(toDeltaSse(upstream, model), {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    const result = await createMuskChatCompletion({
      settings,
      model,
      signal: request.signal,
      messages: toMuskMessages(messages),
      temperature: temperature ?? 0.4,
      jsonMode: false,
      timeoutMs: 90000,
    });

    return NextResponse.json({
      ok: true,
      content: result.content,
      model: result.model,
      usage: result.usage,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message, ok: false }, { status: error.status });
    }
    if (error instanceof MuskApiError) {
      return NextResponse.json(
        { error: error.message, ok: false, code: error.code },
        { status: error.status },
      );
    }
    console.error('[llm/chat]', error);
    return NextResponse.json({ error: '聊天请求失败', ok: false }, { status: 500 });
  }
}
