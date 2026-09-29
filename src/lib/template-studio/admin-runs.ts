import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import type { SessionUser } from '@/lib/auth/session';
import { taskDetailHref } from '@/lib/navigation/return-to';
import { prisma } from '@/lib/prisma';
import { taskThumbnailProjection } from '@/lib/video/task-thumbnail-projection';
import { encodeCursor, parseCursor, requireStudioUser } from './common';
import { StudioError, studioErrorResponse } from './errors';
import type {
  StudioAdminRunDetailResponse,
  StudioAdminRunDto,
  StudioAdminRunListQuery,
  StudioAdminRunListResponse,
  StudioRunStatus,
  StudioTemplateSource,
} from './types';

const PAGE_SIZE = 30;
const SAFE_REVIEW_NOTICE = '本页仅展示本站保存的记录；当前没有上游查单能力。unknown 不代表成功或免费，请人工核对，不要据此自动重发。';
const RUN_STATUSES = new Set<StudioRunStatus>(['queued', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled']);

type AdminUserRow = {
  id: string;
  username: string;
  name: string;
  avatar_url: string | null;
};

type AdminRunRow = {
  id: string;
  owner_user_id: string;
  source: string;
  mode: string;
  status: string;
  delivery_state: string;
  attempt: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  model: string | null;
  usage_json: string | null;
  snapshot_json: string;
  owner: AdminUserRow;
};

export function requireAdminStudioReviewer(user: SessionUser) {
  if (user.role !== 'admin') throw new StudioError('权限不足', 403, 'FORBIDDEN');
  requireStudioUser(user);
}

export async function withAdminStudioRoute(action: (user: SessionUser) => Promise<NextResponse>) {
  try {
    const user = await getAdminUser();
    requireAdminStudioReviewer(user);
    return await action(user);
  } catch (error) {
    return studioErrorResponse(error);
  }
}

function parseDate(value: string | undefined, endExclusive = false) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new StudioError('日期筛选格式无效', 400, 'INVALID');
  if (endExclusive && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function safeDeliveryState(value: string): StudioAdminRunDto['deliveryState'] {
  return value === 'not_sent' || value === 'sending' || value === 'response_received' || value === 'unknown'
    ? value
    : 'unknown';
}

function safeAvatarUrl(value: string | null) {
  if (!value) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value.split(/[?#]/, 1)[0] || null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return null;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function safeDisplayName(name: string, username: string) {
  return (name || username)
    .replace(/https?:\/\/\S+/gi, '[链接已隐藏]')
    .replace(/\b(?:sk[-_]|bearer\s+)[A-Za-z0-9._-]+/gi, '[凭据已隐藏]')
    .slice(0, 120);
}

function safeModel(value: string | null) {
  const model = value?.trim();
  if (!model || model.length > 120 || /^(?:sk[-_]|bearer\s)|(?:api[_-]?key|token|secret|https?:\/\/)/i.test(model) || !/^[\w./:-]+$/.test(model)) return null;
  return model;
}

function safeError(status: string, rawDeliveryState: string) {
  const deliveryState = safeDeliveryState(rawDeliveryState);
  if (status === 'uncertain' || deliveryState === 'unknown') {
    return '上游是否已处理尚未确认；请人工核对本站及服务商记录，系统不会自动重发。';
  }
  if (status === 'failed' && deliveryState === 'not_sent') return '提交上游前失败；未自动重发。';
  if (status === 'failed' && deliveryState === 'response_received') return '已收到响应但本地处理失败；未自动重发。';
  if (status === 'failed') return '执行失败；详细上游错误不在此页展示。';
  if (status === 'cancelled') return '任务已取消。';
  return null;
}

function safeUsage(value: string | null) {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const source = parsed as Record<string, unknown>;
    const summary: NonNullable<StudioAdminRunDto['usage']> = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
      const amount = source[key];
      if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) summary[key] = amount;
    }
    return Object.keys(summary).length ? summary : null;
  } catch {
    return null;
  }
}

function snapshotTemplateName(value: string) {
  try {
    const snapshot: unknown = JSON.parse(value);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const template = (snapshot as { templateVersion?: unknown }).templateVersion;
    if (!template || typeof template !== 'object' || Array.isArray(template)) return null;
    const name = (template as { templateName?: unknown }).templateName;
    if (typeof name !== 'string' || !name.trim()) return null;
    const safeName = name
      .replace(/https?:\/\/\S+/gi, '[链接已隐藏]')
      .replace(/\b(?:sk[-_]|bearer\s+)[A-Za-z0-9._-]+/gi, '[凭据已隐藏]')
      .trim();
    return safeName ? safeName.slice(0, 160) : null;
  } catch {
    return null;
  }
}

function serializeRun(row: AdminRunRow, tasks: Array<{
  id: string;
  template_studio_run_id: string | null;
  local_status: string | null;
  delivery_status: string | null;
  created_at: Date;
  public_video_url: string | null;
  local_video_path: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
}>, taskCount: number): StudioAdminRunDto {
  return {
    id: row.id,
    owner: {
      id: row.owner.id,
      displayName: safeDisplayName(row.owner.name, row.owner.username),
      avatarUrl: safeAvatarUrl(row.owner.avatar_url),
    },
    model: safeModel(row.model),
    source: row.source as StudioAdminRunDto['source'],
    mode: row.mode as StudioAdminRunDto['mode'],
    status: row.status as StudioRunStatus,
    deliveryState: safeDeliveryState(row.delivery_state),
    attempt: Number.isInteger(row.attempt) && row.attempt >= 0 ? row.attempt : 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() || null,
    safeError: safeError(row.status, row.delivery_state),
    usage: safeUsage(row.usage_json),
    templateName: snapshotTemplateName(row.snapshot_json),
    taskCount,
    tasksTruncated: tasks.length < taskCount,
    tasks: tasks.map((task) => {
      const projection = taskThumbnailProjection(task);
      return {
        id: task.id,
        status: task.local_status || 'unknown',
        deliveryStatus: task.delivery_status,
        createdAt: task.created_at.toISOString(),
        thumbnailUrl: projection.thumbnail_url,
        href: taskDetailHref(task.id, '/admin/agent-runs'),
        playUrl: projection.play_url,
        downloadUrl: projection.download_url,
      };
    }),
  };
}

async function resolveTemplateFilter(query: StudioAdminRunListQuery) {
  if (!query.templateId) return null;
  let id = query.templateId.trim().slice(0, 240);
  let source = query.templateSource;
  const prefix = /^(legacy|studio):(.*)$/.exec(id);
  if (prefix) {
    id = prefix[2];
    if (source && source !== prefix[1]) throw new StudioError('模板来源筛选互相冲突', 400, 'INVALID');
    source = prefix[1] as StudioTemplateSource;
  }
  if (!id) throw new StudioError('模板 ID 无效', 400, 'INVALID');
  if (source && source !== 'legacy' && source !== 'studio') throw new StudioError('模板来源无效', 400, 'INVALID');
  if (!source) {
    const [studio, legacy] = await Promise.all([
      prisma.videoStudioTemplate.findUnique({ where: { id }, select: { id: true } }),
      prisma.generationTemplate.findUnique({ where: { id }, select: { id: true } }),
    ]);
    if (studio && legacy) throw new StudioError('新旧模板 ID 冲突，请附带 template_source', 400, 'INVALID');
    source = studio ? 'studio' : legacy ? 'legacy' : undefined;
  }
  return { id, source };
}

function parseStatus(value: StudioRunStatus | undefined) {
  if (value && !RUN_STATUSES.has(value)) throw new StudioError('运行状态筛选无效', 400, 'INVALID');
  return value;
}

export async function listAdminStudioRuns(user: SessionUser, query: StudioAdminRunListQuery): Promise<StudioAdminRunListResponse> {
  requireAdminStudioReviewer(user);
  const status = parseStatus(query.status);
  const template = await resolveTemplateFilter(query);
  const after = parseDate(query.createdAfter);
  const before = parseDate(query.createdBefore, true);
  if (after && before && after >= before) throw new StudioError('结束日期必须晚于开始日期', 400, 'INVALID');
  const cursor = parseCursor(query.cursor);
  if (query.cursor && !cursor) throw new StudioError('分页游标无效，请刷新后重试', 400, 'INVALID');

  const where: Prisma.VideoStudioRunWhereInput = {
    ...(status ? { status } : {}),
    ...(query.ownerUserId ? { owner_user_id: query.ownerUserId.slice(0, 120) } : {}),
    ...(query.requestId ? { request_id: query.requestId.slice(0, 120) } : {}),
    ...(query.draftId ? { draft_id: query.draftId.slice(0, 120) } : {}),
    ...(template ? {
      draft: { is: {
        source_template_id: template.id,
        ...(template.source ? { template_source: template.source } : {}),
      } },
    } : {}),
    AND: [
      ...(after ? [{ created_at: { gte: after } }] : []),
      ...(before ? [{ created_at: { lt: before } }] : []),
      ...(cursor ? [{ OR: [{ created_at: { lt: cursor.date } }, { created_at: cursor.date, id: { lt: cursor.id } }] }] : []),
    ],
  };
  const rows = await prisma.videoStudioRun.findMany({
    where,
    select: {
      id: true, owner_user_id: true, source: true, mode: true, status: true, delivery_state: true,
      attempt: true, created_at: true, updated_at: true, completed_at: true, model: true,
      usage_json: true, snapshot_json: true,
      owner: { select: { id: true, username: true, name: true, avatar_url: true } },
    },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE + 1,
  });
  return projectPage(rows, PAGE_SIZE);
}

async function projectPage(rows: AdminRunRow[], pageSize: number, detail = false): Promise<StudioAdminRunListResponse> {
  const page = rows.slice(0, pageSize);
  const runIds = page.map((row) => row.id);
  const [tasks, counts] = await Promise.all([
    prisma.videoTask.findMany({
      where: { template_studio_run_id: { in: runIds } },
      select: {
        id: true, template_studio_run_id: true, local_status: true, delivery_status: true, created_at: true,
        public_video_url: true, local_video_path: true, result_video_url: true, result_last_frame_url: true,
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    }),
    prisma.videoTask.groupBy({
      by: ['template_studio_run_id'],
      where: { template_studio_run_id: { in: runIds } },
      _count: { _all: true },
    }),
  ]);
  const tasksByRun = new Map<string, typeof tasks>();
  for (const task of tasks) {
    if (!task.template_studio_run_id) continue;
    const group = tasksByRun.get(task.template_studio_run_id) || [];
    group.push(task);
    tasksByRun.set(task.template_studio_run_id, group);
  }
  const countsByRun = new Map(counts.flatMap((row) => row.template_studio_run_id ? [[row.template_studio_run_id, row._count._all] as const] : []));
  const result: StudioAdminRunListResponse = {
    items: page.map((row) => {
      const runTasks = tasksByRun.get(row.id) || [];
      return serializeRun(row, detail ? runTasks : runTasks.slice(0, 5), countsByRun.get(row.id) || 0);
    }),
    nextCursor: rows.length > pageSize && page.at(-1)
      ? encodeCursor(`${page.at(-1)!.created_at.toISOString()}|${page.at(-1)!.id}`)
      : null,
    reviewNotice: SAFE_REVIEW_NOTICE,
  };
  return result;
}

export async function getAdminStudioRun(user: SessionUser, id: string): Promise<StudioAdminRunDetailResponse> {
  requireAdminStudioReviewer(user);
  const row = await prisma.videoStudioRun.findUnique({
    where: { id },
    select: {
      id: true, owner_user_id: true, source: true, mode: true, status: true, delivery_state: true,
      attempt: true, created_at: true, updated_at: true, completed_at: true, model: true,
      usage_json: true, snapshot_json: true,
      owner: { select: { id: true, username: true, name: true, avatar_url: true } },
    },
  });
  if (!row) throw new StudioError('运行记录不存在', 404, 'NOT_FOUND');
  const result = await projectPage([row], 1, true);
  return { run: result.items[0], reviewNotice: result.reviewNotice };
}

export { SAFE_REVIEW_NOTICE };
