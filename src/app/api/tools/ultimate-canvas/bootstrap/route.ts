import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { ensureDefaultProjectForUser } from '@/lib/projects/permissions';
import { canGenerateInVideoCardStatus } from '@/lib/video-cards/permissions';
import {
  getMuskApiSettings,
  isMuskApiReady,
} from '@/lib/integrations/musk';
import {
  getImageGenerationApiSettings,
  isImageGenerationApiReady,
} from '@/lib/integrations/image-generation';
import { getH3ApiSettings, safeH3ConfigDto } from '@/lib/integrations/h3';
import { getProviderConfig, isApiKeyConfigured } from '@/lib/provider/jimeng';
import { getCreditSummary } from '@/lib/credits/policy';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import {
  projectDisplayName,
  projectMetaLabel,
  projectRemovalAction,
  projectRemovalReason,
} from '@/lib/projects/display';
import {
  videoCardRemovalAction,
  videoCardRemovalReason,
  videoCardSpecLabel,
  videoCardStatusLabel,
} from '@/lib/video-cards/display';
import { DURATION_OPTIONS, RATIO_OPTIONS, RESOLUTION_OPTIONS } from '@/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROJECT_TAKE = 100;
const VIDEO_CARD_TAKE = 60;

function imageModelLabel(provider: string, model: string) {
  if (provider === 'seedream') return 'Seedream 5.0 Pro';
  if (provider === 'musk') return 'Gemini Image (Musk)';
  return model || provider || '图片模型';
}

function imageModelCapabilities(provider: string) {
  if (provider === 'seedream') {
    return {
      reference_image_limit: 10,
      max_outputs_per_request: 1,
      size_options: ['1K', '2K'],
      output_formats: ['png', 'jpeg'],
      supports_stream: false,
      supports_sequential_generation: false,
      notes: ['最多 10 张参考图', '单张输出', '生成 URL 会立即入库'],
    };
  }
  return {
    reference_image_limit: 9,
    max_outputs_per_request: 8,
    size_options: [],
    output_formats: ['png'],
    supports_stream: false,
    supports_sequential_generation: false,
    notes: ['通用草图', '兼容现有图片生成流程'],
  };
}

function safeDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function savedVideoCardId(documentJson: string | null | undefined) {
  if (!documentJson) return '';
  try {
    const parsed = JSON.parse(documentJson);
    return typeof parsed?.context?.video_card_id === 'string' ? parsed.context.video_card_id.trim() : '';
  } catch {
    return '';
  }
}

export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const [muskSettings, imageSettings, h3Settings] = await Promise.all([
    getMuskApiSettings(),
    getImageGenerationApiSettings(),
    getH3ApiSettings(),
  ]);
  const videoConfig = getProviderConfig();
  const h3VideoConfig = safeH3ConfigDto(h3Settings);
  const creditSummary = await prisma.$transaction((tx) => getCreditSummary(tx, user));

  await ensureDefaultProjectForUser(user.id);

  const projectWhere = user.role === 'admin'
    ? {
        status: 'active',
        type: { not: 'system' },
      }
    : {
        status: 'active',
        type: { not: 'system' },
        OR: [
          { owner_user_id: user.id },
          {
            type: { in: ['team', 'public'] },
            members: { some: { user_id: user.id, status: 'active', role: { not: 'viewer' } } },
          },
        ],
      };

  const projects = await prisma.project.findMany({
    where: projectWhere,
    orderBy: [{ type: 'asc' }, { updated_at: 'desc' }],
    take: PROJECT_TAKE,
    include: {
      owner: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
      members: {
        where: { user_id: user.id, status: 'active' },
        take: 1,
        select: { user_id: true, role: true, status: true },
      },
      _count: {
        select: {
          tasks: user.role === 'admin'
            ? true
            : { where: { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } } },
          reference_albums: { where: { status: { not: 'deleted' } } },
        },
      },
    },
  });

  const projectSummaries = projects.map((project) => {
    const explicitRole = project.owner_user_id === user.id ? 'project_owner' : project.members[0]?.role || null;
    const myRole = explicitRole || (user.role === 'admin' ? 'admin' : null);
    const isActiveNonSystem = project.status === 'active' && project.type !== 'system';
    const canGenerate = isActiveNonSystem && (user.role === 'admin' || (explicitRole !== null && explicitRole !== 'viewer'));
    const canManageProject = user.role === 'admin' || explicitRole === 'project_owner';
    const canManageAssets = isActiveNonSystem
      && (user.role === 'admin' || explicitRole === 'project_owner' || explicitRole === 'editor');
    const base = {
      id: project.id,
      name: project.name,
      original_name: project.name,
      type: project.type,
      status: project.status,
      owner_user_id: project.owner_user_id,
      owner: project.owner,
      _count: project._count,
      my_role: myRole,
      can_generate: canGenerate,
      can_manage_project: canManageProject,
      can_manage_assets: canManageAssets,
      group: project.owner_user_id === user.id ? 'owned' : explicitRole ? 'joined' : 'other',
      updated_at: safeDate(project.updated_at),
    };
    return {
      ...base,
      display_name: projectDisplayName(base),
      meta_label: projectMetaLabel(base),
      removal_action: projectRemovalAction(base),
      removal_reason: projectRemovalReason(base),
    };
  });

  projectSummaries.sort((a, b) => {
    const groupOrder: Record<string, number> = { owned: 0, joined: 1, other: 2 };
    const groupDelta = groupOrder[a.group] - groupOrder[b.group];
    if (groupDelta !== 0) return groupDelta;
    if (a.type === 'personal' && b.type !== 'personal') return -1;
    if (b.type === 'personal' && a.type !== 'personal') return 1;
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });

  const requestedProjectId = request.nextUrl.searchParams.get('project_id')?.trim() || '';
  const requestedVideoCardId = request.nextUrl.searchParams.get('video_card_id')?.trim() || '';
  const requestedProject = requestedProjectId
    ? projectSummaries.find((project) => project.id === requestedProjectId && project.can_generate) || null
    : null;
  const selectedProject = requestedProject || projectSummaries.find((project) => project.can_generate) || null;
  const latestCanvasDocument = selectedProject
    ? await prisma.canvasDocument.findFirst({
        where: {
          owner_user_id: user.id,
          project_id: selectedProject.id,
          status: 'active',
        },
        orderBy: { updated_at: 'desc' },
        select: { id: true, title: true, project_id: true, document_json: true, updated_at: true },
      })
    : null;

  const videoCards = selectedProject
    ? await prisma.videoCard.findMany({
        where: {
          project_id: selectedProject.id,
          status: { not: 'discarded' },
        },
        orderBy: [{ is_fallback: 'asc' }, { updated_at: 'desc' }],
        take: VIDEO_CARD_TAKE,
        select: {
          id: true,
          project_id: true,
          title: true,
          objective: true,
          status: true,
          owner_user_id: true,
          owner: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
          platform: true,
          ratio: true,
          duration: true,
          target_resolution: true,
          is_fallback: true,
          current_best_task_id: true,
          final_task_id: true,
          updated_at: true,
        },
      })
    : [];

  const videoCardIds = videoCards.map((card) => card.id);
  const [taskCountRows, branchCountRows] = videoCardIds.length
    ? await Promise.all([
        prisma.videoTask.groupBy({
          by: ['video_card_id'],
          where: {
            video_card_id: { in: videoCardIds },
            ...(user.role === 'admin'
              ? {}
              : { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } }),
          },
          _count: { _all: true },
        }),
        prisma.videoBranch.groupBy({
          by: ['video_card_id'],
          where: { video_card_id: { in: videoCardIds } },
          _count: { _all: true },
        }),
      ])
    : [[], []];
  const taskCountByCard = new Map(taskCountRows.map((row) => [row.video_card_id, row._count._all]));
  const branchCountByCard = new Map(branchCountRows.map((row) => [row.video_card_id, row._count._all]));
  const videoCardSummaries = videoCards.map((card) => {
    const summary = { task_count: taskCountByCard.get(card.id) || 0 };
    const canManage = Boolean(selectedProject?.can_manage_project);
    const canGenerate = Boolean(selectedProject?.can_generate) && canGenerateInVideoCardStatus(card.status);
    const base = {
      id: card.id,
      project_id: card.project_id,
      title: card.title,
      objective: card.objective,
      status: card.status,
      owner_user_id: card.owner_user_id,
      owner: card.owner,
      can_generate: canGenerate,
      can_manage: canManage,
      platform: card.platform,
      ratio: card.ratio,
      duration: card.duration,
      target_resolution: card.target_resolution,
      is_fallback: card.is_fallback,
      current_best_task_id: card.current_best_task_id,
      final_task_id: card.final_task_id,
      branch_count: branchCountByCard.get(card.id) || 0,
      summary,
      updated_at: safeDate(card.updated_at),
    };
    return {
      ...base,
      status_label: videoCardStatusLabel(card.status),
      spec_label: videoCardSpecLabel(base),
      removal_action: videoCardRemovalAction(base, canManage),
      removal_reason: videoCardRemovalReason(base, canManage),
    };
  });
  const requestedVideoCard = requestedVideoCardId
    ? videoCardSummaries.find((card) => card.id === requestedVideoCardId) || null
    : null;
  const restoredVideoCardId = requestedVideoCardId ? '' : savedVideoCardId(latestCanvasDocument?.document_json);
  const restoredVideoCard = restoredVideoCardId
    ? videoCardSummaries.find((card) => card.id === restoredVideoCardId && card.can_generate) || null
    : null;
  const selectedVideoCard = requestedVideoCard
    || restoredVideoCard
    || videoCardSummaries.find((card) => card.can_generate)
    || videoCardSummaries[0]
    || null;

  const textReady = isMuskApiReady(muskSettings);
  const imageReady = isImageGenerationApiReady(imageSettings);
  const imageLabel = imageModelLabel(imageSettings.provider, imageSettings.default_model);
  const seedanceVideoReady = isApiKeyConfigured();
  const videoReady = seedanceVideoReady || h3VideoConfig.ready;

  return NextResponse.json({
    backend: { mode: 'sd2', transport: 'same-origin', mock: false },
    tool: {
      id: 'ultimate-canvas',
      name: '无线画布',
      mode: 'formal',
      billing: 'unified_sd2',
    },
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      account_type: user.account_type,
      avatar_url: user.avatar_url || null,
    },
    context: {
      projects: projectSummaries,
      selected_project_id: selectedProject?.id || null,
      video_cards: videoCardSummaries,
      selected_video_card_id: selectedVideoCard?.id || null,
      credits: {
        balance: creditSummary.account.balance,
        available: creditSummary.available,
        frozen_credits: creditSummary.frozen_credits,
        daily_quota: {
          total: creditSummary.daily_total,
          remaining: creditSummary.daily_remaining,
          frozen: creditSummary.daily_frozen,
          expires_at: safeDate(creditSummary.daily_expires_at),
        },
        long_term: {
          available: creditSummary.long_available,
          balance: creditSummary.account.balance,
          frozen: creditSummary.account.frozen_credits,
        },
      },
      canvas_document: latestCanvasDocument ? {
        id: latestCanvasDocument.id,
        title: latestCanvasDocument.title,
        project_id: latestCanvasDocument.project_id,
        updated_at: safeDate(latestCanvasDocument.updated_at),
      } : null,
      needs_project_selection: !selectedProject,
      needs_video_card_selection: !selectedVideoCard,
      selected_video_card_can_generate: Boolean(selectedVideoCard?.can_generate),
      generation_blocked_reason: selectedVideoCard && !selectedVideoCard.can_generate
        ? `视频卡${selectedVideoCard.status_label}，不能继续生成`
        : null,
    },
    capabilities: {
      text: {
        enabled: textReady,
        label: 'gpt5.4 文本能力',
        model: muskSettings.default_model || 'gpt-5.4',
        endpoint: '/api/tools/ultimate-canvas/generate',
        billing: 'operation_log',
        message: textReady ? '可用' : '文本生成能力暂不可用，请稍后联系管理员',
      },
      image: {
        enabled: imageReady,
        label: imageLabel,
        provider: imageSettings.provider,
        model: imageSettings.default_model,
        size: imageSettings.default_size,
        output_format: imageSettings.output_format,
        response_format: imageSettings.response_format,
        watermark: imageSettings.watermark,
        capabilities: imageModelCapabilities(imageSettings.provider),
        interaction: {
          modes: ['text-to-image', 'image-to-image', 'upscale-image', 'first-frame-draft', 'last-frame-draft'],
          ratios: RATIO_OPTIONS,
          size_options: imageModelCapabilities(imageSettings.provider).size_options,
          max_outputs_per_request: imageModelCapabilities(imageSettings.provider).max_outputs_per_request,
          max_reference_images: imageModelCapabilities(imageSettings.provider).reference_image_limit,
        },
        endpoint: '/api/assets/generate',
        billing: 'site_asset_generation',
        requires: ['project_id', 'video_card_id'],
        message: imageReady ? '可用' : '图片生成能力暂不可用，请稍后联系管理员',
      },
      video: {
        enabled: videoReady,
        label: '默认视频 API',
        providers: [
          {
            id: 'seedance',
            label: 'Seedance 视频',
            enabled: seedanceVideoReady,
            ready: seedanceVideoReady,
            model_options: videoConfig.model_options,
          },
          {
            id: 'h3',
            label: 'H3 本地工作站',
            enabled: h3VideoConfig.enabled,
            ready: h3VideoConfig.ready,
            configured: h3VideoConfig.configured,
            model_options: h3VideoConfig.preset_options,
            default_model: h3VideoConfig.default_preset_id,
            lora_options: h3VideoConfig.lora_options,
            default_lora_id: h3VideoConfig.default_lora_id,
          },
        ],
        h3_video: {
          enabled: h3VideoConfig.enabled,
          ready: h3VideoConfig.ready,
          configured: h3VideoConfig.configured,
          default_preset_id: h3VideoConfig.default_preset_id,
          default_lora_id: h3VideoConfig.default_lora_id,
          preset_options: h3VideoConfig.preset_options,
          lora_options: h3VideoConfig.lora_options,
          admin_queue_ready: h3VideoConfig.admin_queue_ready,
          health: h3VideoConfig.health
            ? {
                api: h3VideoConfig.health.api,
                worker: h3VideoConfig.health.worker,
                comfyui: h3VideoConfig.health.comfyui,
                preset_count: h3VideoConfig.health.preset_count,
                checked_at: h3VideoConfig.health.checked_at,
              }
            : null,
        },
        model: videoConfig.model,
        model_options: videoConfig.model_options,
        interaction: {
          modes: [
            'text-to-video',
            'all-reference-video',
            'image-to-video',
            'first-frame-video',
            'first-last-frame-video',
            'image-reference-video',
            'smart-multi-frame-video',
          ],
          ratios: RATIO_OPTIONS,
          durations: DURATION_OPTIONS,
          resolutions: RESOLUTION_OPTIONS,
          supports_audio: true,
          supports_last_frame: true,
          supports_watermark: true,
          model_options: videoConfig.model_options,
          provider_options: h3VideoConfig.ready
            ? ['seedance', 'h3']
            : ['seedance'],
          h3_notes: [
            '首帧和尾帧会由后端转交给 H3',
            '多余参考图、参考视频和音频第一版只作为可见上下文',
            'H3 可通过 lora_id 选择 LoRA；未传时使用 default_lora_id',
          ],
          max_reference_images: 9,
        },
        endpoint: '/api/tasks/create',
        status_endpoint_template: '/api/video/status/:taskId?refresh=true',
        billing: 'credits_and_project_budget',
        requires: ['project_id', 'video_card_id'],
        message: videoReady ? '可用' : '视频生成能力暂不可用，请稍后联系管理员',
      },
    },
  });
}
