import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { getAccessibleProjectIds, getTaskWhereForUser } from '@/lib/projects/permissions';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { displayUserName, displayUserSubtitle } from '@/lib/users/display';

export const dynamic = 'force-dynamic';

const ITEM_TYPES = new Set(['all', 'video', 'image', 'reference']);
const SCOPES = new Set(['history', 'project', 'user']);
const STATUSES = new Set(['all', 'succeeded', 'running', 'submitted', 'failed', 'cancelled', 'hidden']);
const SORTS = new Set(['created_desc', 'created_asc', 'completed_desc', 'project', 'user', 'duration']);
const GROUPS = new Set(['date', 'project', 'user']);

type LibraryItemKind = 'video' | 'image';
type LibraryItemSource = 'video_task' | 'asset' | 'reference_image';

type LibraryUser = {
  id: string;
  name: string | null;
  username: string;
  email: string;
  avatar_url?: string | null;
  account_type?: string | null;
};

type LibraryProject = {
  id: string;
  name: string;
  type?: string | null;
  status?: string | null;
};

type LibraryItem = {
  id: string;
  kind: LibraryItemKind;
  source: LibraryItemSource;
  taskId: string | null;
  assetId: string | null;
  referenceImageId: string | null;
  title: string;
  prompt: string | null;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  downloadUrl: string | null;
  duration: number | null;
  ratio: string | null;
  resolution: string | null;
  provider: string | null;
  generationMode: string | null;
  videoCardId: string | null;
  isEnhanceTask: boolean;
  canEnhanceVideo: boolean;
  enhanceSourceTaskId: string | null;
  status: string;
  retentionStatus: string | null;
  createdAt: string;
  completedAt: string | null;
  project: LibraryProject | null;
  owner: (LibraryUser & { displayName: string; subtitle: string }) | null;
  downloadable: boolean;
  movable: boolean;
};

function enumParam(value: string | null, allowed: Set<string>, fallback: string) {
  const normalized = value?.trim();
  return normalized && allowed.has(normalized) ? normalized : fallback;
}

function positiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function optionalText(value: string | null) {
  const text = value?.trim();
  return text || null;
}

function userSummary(user: LibraryUser | null | undefined) {
  if (!user) return null;
  return {
    ...user,
    displayName: displayUserName(user),
    subtitle: displayUserSubtitle(user),
  };
}

function taskTitle(task: { project: LibraryProject | null; prompt: string; id: string }) {
  const projectName = task.project?.name;
  const prompt = task.prompt.trim();
  if (projectName) return projectName;
  return prompt ? prompt.slice(0, 32) : `任务 ${task.id.slice(0, 8)}`;
}

function parseBaseWhere(
  baseWhere: Prisma.VideoTaskWhereInput,
  filters: Prisma.VideoTaskWhereInput[],
): Prisma.VideoTaskWhereInput {
  return filters.length > 0 ? { AND: [baseWhere, ...filters] } : baseWhere;
}

function taskOrderBy(sort: string): Prisma.VideoTaskOrderByWithRelationInput[] {
  if (sort === 'created_asc') return [{ created_at: 'asc' }];
  if (sort === 'completed_desc') return [{ completed_at: 'desc' }, { created_at: 'desc' }];
  if (sort === 'project') return [{ project: { name: 'asc' } }, { created_at: 'desc' }];
  if (sort === 'user') return [{ owner: { name: 'asc' } }, { user: { name: 'asc' } }, { created_at: 'desc' }];
  if (sort === 'duration') return [{ duration: 'desc' }, { created_at: 'desc' }];
  return [{ created_at: 'desc' }];
}

function isDownloadableTask(task: {
  local_status: string;
  public_video_url?: string | null;
  local_video_path: string | null;
  result_video_url: string | null;
}) {
  return task.local_status === 'succeeded' && Boolean(task.public_video_url || task.local_video_path || task.result_video_url);
}

function serializeTask(task: {
  id: string;
  provider: string;
  generation_mode: string;
  prompt: string;
  local_status: string;
  public_video_url: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  local_video_path: string | null;
  duration: number | null;
  ratio: string | null;
  resolution: string | null;
  video_card_id: string | null;
  params_json: string | null;
  retention_status: string;
  created_at: Date;
  completed_at: Date | null;
  project: LibraryProject | null;
  owner: LibraryUser | null;
  user: LibraryUser | null;
}): LibraryItem {
  const hasVideo = Boolean(task.public_video_url || task.local_video_path || task.result_video_url || task.result_last_frame_url);
  const videoUrl = task.public_video_url || (hasVideo ? `/api/video/play/${task.id}` : null);
  const owner = userSummary(task.owner || task.user);
  const isEnhanceTask = task.generation_mode === 'enhance_video' || task.provider === 'volcengine_mediakit';
  let enhanceSourceTaskId: string | null = null;
  if (isEnhanceTask && task.params_json) {
    try {
      const params = JSON.parse(task.params_json) as { source_task_id?: unknown };
      enhanceSourceTaskId = typeof params.source_task_id === 'string' && params.source_task_id.trim()
        ? params.source_task_id.trim()
        : null;
    } catch {
      enhanceSourceTaskId = null;
    }
  }
  return {
    id: `video_task:${task.id}`,
    kind: 'video',
    source: 'video_task',
    taskId: task.id,
    assetId: null,
    referenceImageId: null,
    title: taskTitle(task),
    prompt: task.prompt,
    thumbnailUrl: hasVideo ? `/api/video/thumbnail/${task.id}` : null,
    previewUrl: videoUrl,
    downloadUrl: videoUrl,
    duration: task.duration,
    ratio: task.ratio,
    resolution: task.resolution,
    provider: task.provider,
    generationMode: task.generation_mode,
    videoCardId: task.video_card_id,
    isEnhanceTask,
    canEnhanceVideo: task.local_status === 'succeeded' && hasVideo && Boolean(task.duration && task.video_card_id) && !isEnhanceTask,
    enhanceSourceTaskId,
    status: task.local_status,
    retentionStatus: task.retention_status,
    createdAt: task.created_at.toISOString(),
    completedAt: task.completed_at ? task.completed_at.toISOString() : null,
    project: task.project,
    owner,
    downloadable: isDownloadableTask(task),
    movable: true,
  };
}

function serializeAsset(asset: {
  id: string;
  original_url: string;
  thumbnail_url: string | null;
  file_name: string;
  type: string;
  status: string;
  width: number | null;
  height: number | null;
  created_at: Date;
  owner_id: string;
}): LibraryItem {
  return {
    id: `asset:${asset.id}`,
    kind: asset.type === 'video' ? 'video' : 'image',
    source: 'asset',
    taskId: null,
    assetId: asset.id,
    referenceImageId: null,
    title: asset.file_name || `素材 ${asset.id.slice(0, 8)}`,
    prompt: null,
    thumbnailUrl: asset.thumbnail_url || asset.original_url,
    previewUrl: asset.original_url,
    downloadUrl: asset.original_url,
    duration: null,
    ratio: asset.width && asset.height ? `${asset.width}:${asset.height}` : null,
    resolution: null,
    provider: null,
    generationMode: null,
    videoCardId: null,
    isEnhanceTask: false,
    canEnhanceVideo: false,
    enhanceSourceTaskId: null,
    status: asset.status,
    retentionStatus: null,
    createdAt: asset.created_at.toISOString(),
    completedAt: null,
    project: null,
    owner: null,
    downloadable: false,
    movable: false,
  };
}

function serializeReferenceImage(image: {
  id: string;
  url: string;
  thumbnail_url: string | null;
  source_type: string;
  status: string;
  created_at: Date;
  project: LibraryProject | null;
  owner: LibraryUser | null;
  album: { id: string; name: string } | null;
  asset_id: string | null;
}): LibraryItem {
  return {
    id: `reference_image:${image.id}`,
    kind: 'image',
    source: 'reference_image',
    taskId: null,
    assetId: image.asset_id,
    referenceImageId: image.id,
    title: image.album?.name || `参考素材 ${image.id.slice(0, 8)}`,
    prompt: image.source_type,
    thumbnailUrl: image.thumbnail_url || image.url,
    previewUrl: image.url,
    downloadUrl: image.url,
    duration: null,
    ratio: null,
    resolution: null,
    provider: null,
    generationMode: null,
    videoCardId: null,
    isEnhanceTask: false,
    canEnhanceVideo: false,
    enhanceSourceTaskId: null,
    status: image.status,
    retentionStatus: null,
    createdAt: image.created_at.toISOString(),
    completedAt: null,
    project: image.project,
    owner: userSummary(image.owner),
    downloadable: false,
    movable: false,
  };
}

function sortItems(items: LibraryItem[], sort: string) {
  const time = (value: string | null) => value ? new Date(value).getTime() : 0;
  return [...items].sort((a, b) => {
    if (sort === 'created_asc') return time(a.createdAt) - time(b.createdAt);
    if (sort === 'completed_desc') return time(b.completedAt || b.createdAt) - time(a.completedAt || a.createdAt);
    if (sort === 'project') return (a.project?.name || '未归属项目').localeCompare(b.project?.name || '未归属项目', 'zh-CN');
    if (sort === 'user') return (a.owner?.displayName || '未知用户').localeCompare(b.owner?.displayName || '未知用户', 'zh-CN');
    if (sort === 'duration') return (b.duration || 0) - (a.duration || 0) || time(b.createdAt) - time(a.createdAt);
    return time(b.createdAt) - time(a.createdAt);
  });
}

function addKeywordFilter(keyword: string | null): Prisma.VideoTaskWhereInput | null {
  if (!keyword) return null;
  return {
    OR: [
      { id: { contains: keyword } },
      { prompt: { contains: keyword } },
      { provider_task_id: { contains: keyword } },
      { source_label: { contains: keyword } },
      { project: { name: { contains: keyword } } },
      { owner: { name: { contains: keyword } } },
      { user: { name: { contains: keyword } } },
    ],
  };
}

async function loadVideoItems(options: {
  type: string;
  scope: string;
  status: string;
  sort: string;
  projectId: string | null;
  ownerUserId: string | null;
  keyword: string | null;
  page: number;
  limit: number;
  includeForMerge: boolean;
}) {
  const user = await getSession();
  if (!user) throw new Error('missing_session');

  if (options.type !== 'all' && options.type !== 'video') {
    return { items: [] as LibraryItem[], total: 0 };
  }

  const includeDeleted = user.role === 'admin' && options.status === 'hidden';
  const baseWhere = await getTaskWhereForUser(user, options.projectId, {
    includeAdminAll: user.role === 'admin',
    includeDeleted,
  });
  const filters: Prisma.VideoTaskWhereInput[] = [];

  if (options.scope === 'user') {
    if (user.role !== 'admin') {
      return { items: [] as LibraryItem[], total: 0 };
    }
    if (options.ownerUserId) {
      filters.push({
        OR: [
          { owner_user_id: options.ownerUserId },
          { user_id: options.ownerUserId },
        ],
      });
    }
  }

  if (options.status === 'hidden') {
    filters.push({ retention_status: { in: ['user_deleted', 'admin_hidden'] } });
  } else if (options.status !== 'all') {
    filters.push({ local_status: options.status });
  }

  const keywordFilter = addKeywordFilter(options.keyword);
  if (keywordFilter) filters.push(keywordFilter);

  const where = parseBaseWhere(baseWhere, filters);
  const take = options.includeForMerge ? options.page * options.limit : options.limit;
  const skip = options.includeForMerge ? 0 : (options.page - 1) * options.limit;
  const [tasks, total] = await Promise.all([
    prisma.videoTask.findMany({
      where,
      orderBy: taskOrderBy(options.sort),
      skip,
      take,
      select: {
        id: true,
        provider: true,
        generation_mode: true,
        prompt: true,
        local_status: true,
        public_video_url: true,
        result_video_url: true,
        result_last_frame_url: true,
        local_video_path: true,
        duration: true,
        ratio: true,
        resolution: true,
        video_card_id: true,
        params_json: true,
        retention_status: true,
        created_at: true,
        completed_at: true,
        project: { select: { id: true, name: true, type: true, status: true } },
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      },
    }),
    prisma.videoTask.count({ where }),
  ]);

  return {
    items: tasks.map(serializeTask),
    total,
  };
}

async function loadAssetItems(options: {
  userId: string;
  role: 'admin' | 'user';
  type: string;
  scope: string;
  status: string;
  ownerUserId: string | null;
  keyword: string | null;
  take: number;
}) {
  if (options.type !== 'all' && options.type !== 'image' && options.type !== 'video') {
    return { items: [] as LibraryItem[], total: 0 };
  }

  const where: Prisma.AssetWhereInput = {
    status: options.status === 'hidden' ? { in: ['hidden', 'deleted'] } : 'active',
  };
  if (options.type === 'image') where.type = 'image';
  else if (options.type === 'video') where.type = 'video';
  else where.type = { in: ['image', 'video'] };
  if (options.role === 'admin' && options.scope === 'user' && options.ownerUserId) {
    where.owner_id = options.ownerUserId;
  } else if (options.role !== 'admin') {
    where.owner_id = options.userId;
  }
  if (options.keyword) {
    where.file_name = { contains: options.keyword };
  }

  const [assets, total] = await Promise.all([
    prisma.asset.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: options.take,
      select: {
        id: true,
        original_url: true,
        thumbnail_url: true,
        file_name: true,
        type: true,
        status: true,
        width: true,
        height: true,
        created_at: true,
        owner_id: true,
      },
    }),
    prisma.asset.count({ where }),
  ]);

  return { items: assets.map(serializeAsset), total };
}

async function loadReferenceItems(options: {
  user: SessionUser;
  type: string;
  scope: string;
  projectId: string | null;
  ownerUserId: string | null;
  keyword: string | null;
  take: number;
}) {
  if (options.type !== 'all' && options.type !== 'reference') {
    return { items: [] as LibraryItem[], total: 0 };
  }

  const where: Prisma.ReferenceImageWhereInput = { status: 'active' };
  if (options.projectId) {
    where.project_id = options.projectId;
  }
  if (options.user.role === 'admin') {
    if (options.scope === 'user' && options.ownerUserId) where.owner_user_id = options.ownerUserId;
  } else {
    const accessibleProjectIds = await getAccessibleProjectIds(options.user);
    where.OR = [
      { owner_user_id: options.user.id },
      { project_id: { in: accessibleProjectIds } },
      { album: { visibility: 'public' } },
      { album: { album_type: { in: ['public', 'system'] } } },
    ];
  }
  if (options.keyword) {
    where.album = { name: { contains: options.keyword } };
  }

  const [images, total] = await Promise.all([
    prisma.referenceImage.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: options.take,
      select: {
        id: true,
        url: true,
        thumbnail_url: true,
        source_type: true,
        status: true,
        created_at: true,
        asset_id: true,
        project: { select: { id: true, name: true, type: true, status: true } },
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        album: { select: { id: true, name: true } },
      },
    }),
    prisma.referenceImage.count({ where }),
  ]);

  return { items: images.map(serializeReferenceImage), total };
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const searchParams = request.nextUrl.searchParams;
    const type = enumParam(searchParams.get('type'), ITEM_TYPES, 'video');
    const scope = enumParam(searchParams.get('scope'), SCOPES, 'history');
    const status = enumParam(searchParams.get('status'), STATUSES, 'all');
    const sort = enumParam(searchParams.get('sort'), SORTS, 'created_desc');
    const groupBy = enumParam(searchParams.get('group_by'), GROUPS, 'date');
    const projectId = optionalText(searchParams.get('project_id'));
    const ownerUserId = optionalText(searchParams.get('owner_user_id'));
    const keyword = optionalText(searchParams.get('keyword'));
    const page = positiveInt(searchParams.get('page'), 1, 10_000);
    const limit = positiveInt(searchParams.get('limit'), 40, 100);
    const includeForMerge = type === 'all';

    if (scope === 'user' && user.role !== 'admin') {
      return NextResponse.json({ error: '权限不足' }, { status: 403 });
    }

    const takeForMerge = page * limit;
    const [videoResult, assetResult, referenceResult] = await Promise.all([
      loadVideoItems({
        type,
        scope,
        status,
        sort,
        projectId,
        ownerUserId,
        keyword,
        page,
        limit,
        includeForMerge,
      }),
      loadAssetItems({
        userId: user.id,
        role: user.role,
        type,
        scope,
        status,
        ownerUserId,
        keyword,
        take: includeForMerge ? takeForMerge : limit,
      }),
      loadReferenceItems({
        user,
        type,
        scope,
        projectId,
        ownerUserId,
        keyword,
        take: includeForMerge ? takeForMerge : limit,
      }),
    ]);

    const merged = sortItems([
      ...videoResult.items,
      ...assetResult.items,
      ...referenceResult.items,
    ], sort);
    const total = videoResult.total + assetResult.total + referenceResult.total;
    const items = includeForMerge
      ? merged.slice((page - 1) * limit, page * limit)
      : merged;

    return NextResponse.json({
      items,
      summary: {
        total,
        downloadable: items.filter((item) => item.downloadable).length,
        movable: items.filter((item) => item.movable).length,
      },
      query: {
        type,
        scope,
        status,
        sort,
        group_by: groupBy,
        project_id: projectId,
        owner_user_id: ownerUserId,
        keyword,
      },
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.max(1, Math.ceil(total / limit)),
        has_more: page * limit < total,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'missing_session') {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }
    console.error('[AssetLibrary] List error:', error);
    return NextResponse.json(
      { error: '资产加载失败', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
