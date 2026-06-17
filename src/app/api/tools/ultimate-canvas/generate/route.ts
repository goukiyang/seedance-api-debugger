import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import {
  createMuskChatCompletion,
  getMuskApiSettings,
  isMuskApiReady,
  MuskApiError,
} from '@/lib/integrations/musk';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUPPORTED_TEXT_KINDS = new Set(['text', 'script']);
const MAX_PROMPT_LENGTH = 12000;

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function trimForPrompt(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function normalizeKind(value: unknown) {
  const kind = cleanString(value, 'text').toLowerCase();
  return SUPPORTED_TEXT_KINDS.has(kind) ? kind : '';
}

function compactSourceNodes(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => {
    const source = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const data = source.data && typeof source.data === 'object'
      ? source.data as Record<string, unknown>
      : {};
    return {
      id: cleanString(source.id),
      type: cleanString(source.type),
      title: cleanString(data.title),
      prompt: trimForPrompt(cleanString(data.prompt), 1200),
      description: trimForPrompt(cleanString(data.description), 1200),
      generated_text: trimForPrompt(cleanString(data.generatedText), 1200),
    };
  }).filter((item) => item.id || item.title || item.prompt || item.description || item.generated_text);
}

function parseLlmJson(content: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('LLM 返回内容不是可解析 JSON');
  }

  const data = parsed && typeof parsed === 'object'
    ? parsed as Record<string, unknown>
    : {};
  const title = cleanString(data.title, '文本草稿').slice(0, 80);
  const text = cleanString(data.content) || cleanString(data.text);
  if (!text) throw new Error('LLM 返回内容缺少 content');

  const nextActions = Array.isArray(data.nextActions)
    ? data.nextActions
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .map((item) => item.trim())
      .slice(0, 6)
    : [];

  return {
    title,
    content: text,
    summary: cleanString(data.summary).slice(0, 240),
    nextActions,
  };
}

async function writeCanvasLog(params: {
  userId: string;
  action: string;
  nodeId: string | null;
  detail: Record<string, unknown>;
}) {
  try {
    await prisma.operationLog.create({
      data: {
        operator_id: params.userId,
        action: params.action,
        target_type: 'UltimateCanvasNode',
        target_id: params.nodeId,
        detail: JSON.stringify(params.detail),
      },
    });
  } catch (error) {
    console.warn('[UltimateCanvas] OperationLog write failed:', error);
  }
}

export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '未登录，请先登录后再使用无线画布 LLM' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: '请求体不是有效 JSON' }, { status: 400 });
  }

  const nodeId = cleanString(body.nodeId).slice(0, 120) || null;
  const kind = normalizeKind(body.kind);
  const mode = cleanString(body.mode, 'text').slice(0, 80);
  const prompt = cleanString(body.prompt).slice(0, MAX_PROMPT_LENGTH);
  const title = cleanString(body.title).slice(0, 120);
  const sourceNodes = compactSourceNodes(body.sourceNodes);

  if (!kind) {
    return NextResponse.json(
      { error: '当前接口只支持文本/脚本节点，图片和视频节点需要走对应生成链路' },
      { status: 400 },
    );
  }
  if (!prompt) {
    return NextResponse.json({ error: '请输入要生成或改写的内容' }, { status: 400 });
  }

  const settings = await getMuskApiSettings();
  if (!isMuskApiReady(settings)) {
    await writeCanvasLog({
      userId: user.id,
      action: 'ultimate_canvas_llm_generate',
      nodeId,
      detail: { status: 'failed', reason: 'musk_api_not_configured', kind, mode },
    });
    return NextResponse.json(
      { error: 'Musk API 未启用或缺少 API Key，请先到后台 API 设置完成配置' },
      { status: 503 },
    );
  }

  const requestContext = {
    node: { nodeId, kind, mode, title },
    prompt,
    sourceNodes,
  };

  try {
    const completion = await createMuskChatCompletion({
      settings,
      temperature: 0.35,
      timeoutMs: 60000,
      messages: [
        {
          role: 'system',
          content: [
            '你是无线画布里的中文创作助手，负责把用户输入扩写成可继续生产图片、视频或脚本的清晰文本。',
            '必须只返回 JSON 对象，不要返回 Markdown。JSON 字段固定为：title、content、summary、nextActions。',
            'content 用中文输出，保留可执行的画面、角色、动作、情绪和结构；不要编造后台状态、点数或任务结果。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(requestContext),
        },
      ],
    });

    const parsed = parseLlmJson(completion.content);
    await writeCanvasLog({
      userId: user.id,
      action: 'ultimate_canvas_llm_generate',
      nodeId,
      detail: {
        status: 'succeeded',
        kind,
        mode,
        model: completion.model || settings.default_model,
        prompt_length: prompt.length,
        source_node_count: sourceNodes.length,
      },
    });

    return NextResponse.json({
      id: `canvas-llm-${randomUUID()}`,
      status: 'succeeded',
      provider: 'musk',
      kind,
      mode,
      message: 'LLM 生成完成',
      title: parsed.title,
      text: parsed.content,
      content: parsed.content,
      summary: parsed.summary,
      next_actions: parsed.nextActions,
      model: completion.model || settings.default_model,
      usage: completion.usage,
    });
  } catch (error) {
    const status = error instanceof MuskApiError ? error.status : 502;
    const message = error instanceof Error ? error.message : '无线画布 LLM 生成失败';
    await writeCanvasLog({
      userId: user.id,
      action: 'ultimate_canvas_llm_generate',
      nodeId,
      detail: {
        status: 'failed',
        kind,
        mode,
        reason: error instanceof MuskApiError ? error.code : 'llm_response_error',
      },
    });
    return NextResponse.json({ error: message }, { status });
  }
}
