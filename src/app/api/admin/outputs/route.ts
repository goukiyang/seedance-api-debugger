import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { prisma } from '@/lib/prisma';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';

export const dynamic = 'force-dynamic';

const VALID_TASK_STATUSES = new Set(['draft', 'submitted', 'running', 'succeeded', 'failed', 'cancelled']);
const VALID_RETENTION_STATUSES = new Set(['active', 'user_deleted', 'admin_hidden', 'retained']);
const VALID_RESOLUTIONS = new Set(['480p', '720p', '1080p', 'unknown']);

function parsePositiveInt(value: string | null, fallback: number, max: number) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return fallback;
  return Math.min(Math.floor(numericValue), max);
}

function parseDate(value: string | null, endOfDay = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setHours(23, 59, 59, 999);
  }
  return date;
}

function normalizeResolution(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === '480p' || normalized === '720p' || normalized === '1080p') return normalized;
  if (normalized === 'unknown') return 'unknown';
  return null;
}

function buildWhere(searchParams: URLSearchParams): Prisma.VideoTaskWhereInput {
  const where: Prisma.VideoTaskWhereInput = {};
  const andFilters: Prisma.VideoTaskWhereInput[] = [];
  const localStatus = searchParams.get('status');
  const retentionStatus = searchParams.get('retention_status');
  const ownerUserId = searchParams.get('owner_user_id');
  const projectId = searchParams.get('project_id');
  const resolution = normalizeResolution(searchParams.get('resolution'));
  const keyword = (searchParams.get('keyword') || '').trim();
  const dateFrom = parseDate(searchParams.get('date_from'));
  const dateTo = parseDate(searchParams.get('date_to'), true);
  const includeDeleted = searchParams.get('include_deleted') !== 'false';

  if (localStatus && VALID_TASK_STATUSES.has(localStatus)) {
    where.local_status = localStatus;
  }

  if (retentionStatus && VALID_RETENTION_STATUSES.has(retentionStatus)) {
    where.retention_status = retentionStatus;
  } else if (!includeDeleted) {
    where.retention_status = { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] };
  }

  if (ownerUserId) {
    andFilters.push({
      OR: [
        { owner_user_id: ownerUserId },
        { user_id: ownerUserId },
      ],
    });
  }
  if (projectId) where.project_id = projectId === 'unassigned' ? null : projectId;
  if (resolution && VALID_RESOLUTIONS.has(resolution)) {
    if (resolution === 'unknown') {
      andFilters.push({
        OR: [
          { resolution: null },
          { resolution: { notIn: ['480p', '720p', '1080p'] } },
        ],
      });
    } else {
      where.resolution = resolution;
    }
  }

  if (dateFrom || dateTo) {
    where.created_at = {
      ...(dateFrom ? { gte: dateFrom } : {}),
      ...(dateTo ? { lte: dateTo } : {}),
    };
  }

  if (keyword) {
    where.OR = [
      { id: { contains: keyword } },
      { prompt: { contains: keyword } },
      { provider_task_id: { contains: keyword } },
      { source_type: { contains: keyword } },
      { source_label: { contains: keyword } },
      { source_request_id: { contains: keyword } },
      { error_message: { contains: keyword } },
    ];
  }

  if (andFilters.length > 0) {
    where.AND = andFilters;
  }

  return where;
}

function userSummary(user: {
  id: string;
  name: string | null;
  username: string;
  email: string;
  avatar_url: string | null;
  account_type: string;
} | null | undefined) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    avatar_url: user.avatar_url,
    account_type: user.account_type,
  };
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);

    const searchParams = request.nextUrl.searchParams;
    const page = parsePositiveInt(searchParams.get('page'), 1, 10_000);
    const limit = parsePositiveInt(searchParams.get('limit'), 30, 100);
    const where = buildWhere(searchParams);
    const skip = (page - 1) * limit;

    const [total, tasks, retentionGroups, statusGroups] = await Promise.all([
      prisma.videoTask.count({ where }),
      prisma.videoTask.findMany({
        where,
        orderBy: [{ created_at: 'desc' }],
        skip,
        take: limit,
        select: {
          id: true,
          prompt: true,
          provider: true,
          source_type: true,
          source_label: true,
          source_request_id: true,
          local_status: true,
          provider_task_id: true,
          provider_status: true,
          model: true,
          generation_mode: true,
          resolution: true,
          duration: true,
          ratio: true,
          estimated_cost: true,
          actual_cost: true,
          frozen_cost: true,
          refund_amount: true,
          provider_cost_status: true,
          provider_official_amount_minor: true,
          provider_official_amount_micros: true,
          provider_cost_currency: true,
          result_video_url: true,
          result_last_frame_url: true,
          local_video_path: true,
          reference_image_ids: true,
          reference_album_ids: true,
          project_id: true,
          owner_user_id: true,
          user_id: true,
          retention_status: true,
          user_deleted_at: true,
          user_deleted_by: true,
          admin_hidden_at: true,
          admin_hidden_by: true,
          restored_at: true,
          restored_by: true,
          delete_reason: true,
          created_at: true,
          completed_at: true,
          owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
          user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
          project: { select: { id: true, name: true, type: true, status: true } },
        },
      }),
      prisma.videoTask.groupBy({
        by: ['retention_status'],
        _count: { _all: true },
      }),
      prisma.videoTask.groupBy({
        by: ['local_status'],
        _count: { _all: true },
      }),
    ]);

    const actorIds = Array.from(new Set(tasks.flatMap((task) => [
      task.user_deleted_by,
      task.admin_hidden_by,
      task.restored_by,
    ]).filter((value): value is string => Boolean(value))));
    const actors = actorIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true },
        })
      : [];
    const actorById = new Map(actors.map((actor) => [actor.id, actor]));

    return NextResponse.json({
      outputs: tasks.map((task) => ({
        ...task,
        is_enhance_task: task.generation_mode === 'enhance_video' || task.provider === 'volcengine_mediakit',
        owner: userSummary(task.owner || task.user),
        submitted_user: userSummary(task.user),
        user_deleted_by_user: userSummary(task.user_deleted_by ? actorById.get(task.user_deleted_by) : null),
        admin_hidden_by_user: userSummary(task.admin_hidden_by ? actorById.get(task.admin_hidden_by) : null),
        restored_by_user: userSummary(task.restored_by ? actorById.get(task.restored_by) : null),
      })),
      summary: {
        total_all: retentionGroups.reduce((sum, item) => sum + item._count._all, 0),
        retention: Object.fromEntries(retentionGroups.map((item) => [item.retention_status, item._count._all])),
        statuses: Object.fromEntries(statusGroups.map((item) => [item.local_status, item._count._all])),
      },
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('[AdminOutputs] List error:', error);
    const status = error && typeof error === 'object' && 'status' in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '加载产出失败' },
      { status },
    );
  }
}
