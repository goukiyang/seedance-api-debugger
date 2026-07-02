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
import { getProviderConfig, isApiKeyConfigured } from '@/lib/provider/jimeng';
import { getCreditSummary } from '@/lib/credits/policy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROJECT_TAKE = 20;
const VIDEO_CARD_TAKE = 30;

function safeDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
  if (user.role !== 'admin') {
    return NextResponse.json({ error: '权限不足', message: '无线画布暂时只对管理员开放' }, { status: 403 });
  }

  const [muskSettings, imageSettings] = await Promise.all([
    getMuskApiSettings(),
    getImageGenerationApiSettings(),
  ]);
  const videoConfig = getProviderConfig();
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
            members: { some: { user_id: user.id, status: 'active' } },
          },
        ],
      };

  const projects = await prisma.project.findMany({
    where: projectWhere,
    orderBy: [{ type: 'asc' }, { updated_at: 'desc' }],
    take: PROJECT_TAKE,
    include: {
      members: user.role === 'admin'
        ? { where: { status: 'active' }, select: { user_id: true, role: true, status: true } }
        : { where: { user_id: user.id }, select: { user_id: true, role: true, status: true } },
    },
  });

  const projectSummaries = projects.map((project) => {
    const myRole = user.role === 'admin'
      ? 'admin'
      : (project.owner_user_id === user.id ? 'project_owner' : project.members[0]?.role || null);
    const canGenerate = project.status === 'active' && myRole !== null && myRole !== 'viewer';
    return {
      id: project.id,
      name: project.name,
      type: project.type,
      status: project.status,
      my_role: myRole,
      can_generate: canGenerate,
      updated_at: safeDate(project.updated_at),
    };
  });

  const requestedProjectId = request.nextUrl.searchParams.get('project_id')?.trim() || '';
  const requestedVideoCardId = request.nextUrl.searchParams.get('video_card_id')?.trim() || '';
  const requestedProject = requestedProjectId
    ? projectSummaries.find((project) => project.id === requestedProjectId && project.can_generate) || null
    : null;
  const selectedProject = requestedProject || projectSummaries.find((project) => project.can_generate) || null;
  const videoCards = selectedProject
    ? await prisma.videoCard.findMany({
        where: {
          project_id: selectedProject.id,
          status: { in: ['draft', 'active', 'reviewing'] },
        },
        orderBy: [{ is_fallback: 'asc' }, { updated_at: 'desc' }],
        take: VIDEO_CARD_TAKE,
        select: {
          id: true,
          project_id: true,
          title: true,
          status: true,
          platform: true,
          ratio: true,
          duration: true,
          target_resolution: true,
          updated_at: true,
        },
      })
    : [];

  const videoCardSummaries = videoCards.map((card) => ({
    id: card.id,
    project_id: card.project_id,
    title: card.title,
    status: card.status,
    can_generate: canGenerateInVideoCardStatus(card.status),
    platform: card.platform,
    ratio: card.ratio,
    duration: card.duration,
    target_resolution: card.target_resolution,
    updated_at: safeDate(card.updated_at),
  }));
  const requestedVideoCard = requestedVideoCardId
    ? videoCardSummaries.find((card) => card.id === requestedVideoCardId && card.can_generate) || null
    : null;
  const selectedVideoCard = requestedVideoCard || videoCardSummaries.find((card) => card.can_generate) || null;

  const latestCanvasDocument = selectedProject
    ? await prisma.canvasDocument.findFirst({
        where: {
          owner_user_id: user.id,
          project_id: selectedProject.id,
          status: 'active',
        },
        orderBy: { updated_at: 'desc' },
        select: { id: true, title: true, project_id: true, updated_at: true },
      })
    : null;

  const textReady = isMuskApiReady(muskSettings);
  const imageReady = isImageGenerationApiReady(imageSettings);
  const videoReady = isApiKeyConfigured();

  return NextResponse.json({
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
    },
    capabilities: {
      text: {
        enabled: textReady,
        label: 'gpt5.4 文本能力',
        model: muskSettings.default_model || 'gpt-5.4',
        endpoint: '/api/tools/ultimate-canvas/generate',
        billing: 'operation_log',
        message: textReady ? '可用' : '后台 Musk API 未启用或缺少 API Key',
      },
      image: {
        enabled: imageReady,
        label: 'gmini 图形生成',
        provider: imageSettings.provider,
        model: imageSettings.default_model,
        endpoint: '/api/assets/generate',
        billing: 'site_asset_generation',
        requires: ['project_id', 'video_card_id'],
        message: imageReady ? '可用' : '后台图形生成 API 未启用或缺少配置',
      },
      video: {
        enabled: videoReady,
        label: '默认视频 API',
        model: videoConfig.model,
        endpoint: '/api/tasks/create',
        status_endpoint_template: '/api/video/status/:taskId?refresh=true',
        billing: 'credits_and_project_budget',
        requires: ['project_id', 'video_card_id'],
        message: videoReady ? '可用' : 'SEEDANCE_API_KEY 未配置',
      },
    },
  });
}
