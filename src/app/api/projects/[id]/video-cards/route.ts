import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import {
  assertCanGenerateInProject,
  assertCanViewProject,
  logProjectAction,
} from '@/lib/projects/permissions';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { normalizeVideoCardStatus } from '@/lib/video-cards/permissions';
import { getVideoCardSummaryMap, serializeVideoCardSummary } from '@/lib/video-cards/summary';

export const dynamic = 'force-dynamic';

function asOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function serializeTaskPreview(task: null | {
  id: string;
  prompt: string;
  local_status: string;
  local_video_path: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  created_at: Date;
}) {
  if (!task) return null;
  return {
    id: task.id,
    prompt: task.prompt,
    local_status: task.local_status,
    local_video_path: task.local_video_path,
    result_video_url: task.result_video_url,
    result_last_frame_url: task.result_last_frame_url,
    created_at: task.created_at,
  };
}

function serializeVideoCard(card: any, summary: any) {
  return {
    id: card.id,
    project_id: card.project_id,
    title: card.title,
    objective: card.objective,
    status: card.status,
    owner_user_id: card.owner_user_id,
    owner: card.owner,
    platform: card.platform,
    ratio: card.ratio,
    duration: card.duration,
    target_resolution: card.target_resolution,
    budget_credits: card.budget_credits,
    budget_currency: card.budget_currency,
    current_best_task_id: card.current_best_task_id,
    final_task_id: card.final_task_id,
    current_best_task: serializeTaskPreview(card.current_best_task),
    final_task: serializeTaskPreview(card.final_task),
    is_fallback: card.is_fallback,
    created_by: card.created_by,
    created_at: card.created_at,
    updated_at: card.updated_at,
    summary: serializeVideoCardSummary(summary),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const access = await assertCanViewProject(user, params.id);
    const cards = await prisma.videoCard.findMany({
      where: { project_id: params.id },
      orderBy: [{ is_fallback: 'asc' }, { updated_at: 'desc' }],
      include: {
        owner: { select: { id: true, name: true, username: true, email: true } },
        current_best_task: {
          select: { id: true, prompt: true, local_status: true, local_video_path: true, result_video_url: true, result_last_frame_url: true, created_at: true },
        },
        final_task: {
          select: { id: true, prompt: true, local_status: true, local_video_path: true, result_video_url: true, result_last_frame_url: true, created_at: true },
        },
      },
    });

    const taskWhere = user.role === 'admin'
      ? {}
      : { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } };
    const summaryMap = await getVideoCardSummaryMap(cards.map((card) => card.id), { taskWhere });

    return NextResponse.json({
      video_cards: cards.map((card) => serializeVideoCard(card, summaryMap.get(card.id))),
      permissions: {
        role: access.role,
        can_generate: access.canGenerate,
        can_manage_project: access.canManageProject,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[VideoCards] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanGenerateInProject(user, params.id);
    const body = await request.json();
    const title = asOptionalString(body.title);
    if (!title) {
      return NextResponse.json({ error: '视频卡标题不能为空' }, { status: 400 });
    }

    const status = normalizeVideoCardStatus(body.status, 'active');
    const card = await prisma.videoCard.create({
      data: {
        project_id: params.id,
        title,
        objective: asOptionalString(body.objective),
        status,
        owner_user_id: user.id,
        platform: asOptionalString(body.platform),
        ratio: asOptionalString(body.ratio),
        duration: asOptionalNumber(body.duration),
        target_resolution: asOptionalString(body.target_resolution ?? body.targetResolution),
        budget_credits: asOptionalNumber(body.budget_credits ?? body.budgetCredits),
        budget_currency: asOptionalString(body.budget_currency ?? body.budgetCurrency) || 'credits',
        created_by: user.id,
      },
      include: {
        owner: { select: { id: true, name: true, username: true, email: true } },
        current_best_task: {
          select: { id: true, prompt: true, local_status: true, local_video_path: true, result_video_url: true, result_last_frame_url: true, created_at: true },
        },
        final_task: {
          select: { id: true, prompt: true, local_status: true, local_video_path: true, result_video_url: true, result_last_frame_url: true, created_at: true },
        },
      },
    });

    await logProjectAction(user.id, 'video_card_create', 'video_card', card.id, {
      project_id: params.id,
      title: card.title,
    });

    const summaryMap = await getVideoCardSummaryMap([card.id]);
    return NextResponse.json(
      { video_card: serializeVideoCard(card, summaryMap.get(card.id)) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[VideoCards] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
