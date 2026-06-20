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
import { AuthError } from '@/lib/auth/session';
import { getProjectForGeneration } from '@/lib/projects/permissions';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';

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
  const rawContextRules = cleanString(body.contextRules || body.context_rules).slice(0, 4000);
  const contextRules = user.role === 'admin' ? rawContextRules : '';
  const requestedProjectId = cleanString(body.project_id || body.projectId) || null;
  const requestedVideoCardId = cleanString(body.video_card_id || body.videoCardId) || null;
  const canvasDocumentId = cleanString(body.canvas_document_id || body.canvasDocumentId) || null;

  let projectId: string | null = null;
  let videoCardId: string | null = null;
  if (requestedVideoCardId) {
    const videoCard = await prisma.videoCard.findUnique({
      where: { id: requestedVideoCardId },
      select: { id: true, project_id: true },
    });
    if (!videoCard) return NextResponse.json({ error: '视频卡不存在' }, { status: 404 });
    if (requestedProjectId && requestedProjectId !== videoCard.project_id) {
      return NextResponse.json({ error: '视频卡不属于当前项目' }, { status: 400 });
    }
    try {
      const project = await getProjectForGeneration(user, videoCard.project_id);
      await assertCanGenerateInVideoCard(user, project.id, videoCard.id);
      projectId = project.id;
      videoCardId = videoCard.id;
    } catch (error) {
      if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }

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
      detail: { status: 'failed', reason: 'musk_api_not_configured', kind, mode, project_id: projectId, video_card_id: videoCardId, canvas_document_id: canvasDocumentId },
    });
    return NextResponse.json(
      { error: 'Musk API 未启用或缺少 API Key，请先到后台 API 设置完成配置' },
      { status: 503 },
    );
  }

  const requestContext = {
    node: { nodeId, kind, mode, title },
    prompt,
    contextRules: contextRules
      ? {
          source: 'admin_node_context_rules',
          content: contextRules,
        }
      : null,
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
            '如果用户消息里的 contextRules 有内容，它是管理员设置的高优先级上下文规则，必须遵守；如与普通输入冲突，优先遵守 contextRules。',
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
        project_id: projectId,
        video_card_id: videoCardId,
        canvas_document_id: canvasDocumentId,
        model: completion.model || settings.default_model,
        prompt_length: prompt.length,
        source_node_count: sourceNodes.length,
        context_rules_applied: Boolean(contextRules),
        context_rules_ignored: Boolean(rawContextRules && !contextRules),
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
        project_id: projectId,
        video_card_id: videoCardId,
        canvas_document_id: canvasDocumentId,
        reason: error instanceof MuskApiError ? error.code : 'llm_response_error',
      },
    });
    return NextResponse.json({ error: message }, { status });
  }
}
