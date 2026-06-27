import { stat } from 'fs/promises';
import { ZipFile } from 'yazl';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { displayUserName } from '@/lib/users/display';
import { formatAmountMicrosWithFixedCny, formatAmountMinorWithFixedCny } from '@/lib/costs/currency';
import { assertCanViewProject, assertCanViewTask } from '@/lib/projects/permissions';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { cacheTaskVideoToLocal, type CacheableVideoTask } from '@/lib/video/local-cache';
import { localPublicVideoPath } from '@/lib/video/thumbnail';

export const BULK_VIDEO_DOWNLOAD_LIMIT = 20;

type BulkDownloadScope = {
  taskIds?: string[];
  projectId?: string;
};

type BulkVideoTask = CacheableVideoTask & {
  prompt: string;
  resolution: string | null;
  duration: number | null;
  ratio: string | null;
  created_at: Date;
  completed_at: Date | null;
  project_id: string | null;
  owner_user_id: string | null;
  user_id: string | null;
  retention_status: string | null;
  provider_cost_currency: string | null;
  provider_official_amount_minor: number | null;
  provider_final_amount_minor: number | null;
  provider_official_amount_micros: number | null;
  provider_final_amount_micros: number | null;
  project: { id: string; name: string; type: string } | null;
  owner: { id: string; name: string | null; username: string; email: string; account_type: string } | null;
  user: { id: string; name: string | null; username: string; email: string; account_type: string } | null;
};

type BulkDownloadItem = {
  task: BulkVideoTask | null;
  taskId: string;
  status: 'success' | 'failed';
  fileName: string;
  localVideoPath: string | null;
  absolutePath: string | null;
  fileSize: number | null;
  errorMessage: string | null;
};

export type BulkVideoDownloadJsonResult = {
  kind: 'json';
  status: number;
  body: Record<string, unknown>;
};

export type BulkVideoDownloadZipResult = {
  kind: 'zip';
  status: 200;
  fileName: string;
  stream: NodeJS.ReadableStream;
  summary: {
    total: number;
    success: number;
    failed: number;
  };
};

export type BulkVideoDownloadResult = BulkVideoDownloadJsonResult | BulkVideoDownloadZipResult;

const taskSelect = {
  id: true,
  provider: true,
  prompt: true,
  local_status: true,
  provider_task_id: true,
  result_video_url: true,
  result_last_frame_url: true,
  local_video_path: true,
  resolution: true,
  duration: true,
  ratio: true,
  created_at: true,
  completed_at: true,
  project_id: true,
  owner_user_id: true,
  user_id: true,
  retention_status: true,
  provider_cost_currency: true,
  provider_official_amount_minor: true,
  provider_final_amount_minor: true,
  provider_official_amount_micros: true,
  provider_final_amount_micros: true,
  project: { select: { id: true, name: true, type: true } },
  owner: { select: { id: true, name: true, username: true, email: true, account_type: true } },
  user: { select: { id: true, name: true, username: true, email: true, account_type: true } },
} satisfies Prisma.VideoTaskSelect;

function jsonResult(status: number, body: Record<string, unknown>): BulkVideoDownloadJsonResult {
  return { kind: 'json', status, body };
}

function normalizeTaskIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseBulkDownloadScope(body: unknown): BulkDownloadScope {
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const taskIds = normalizeTaskIds(payload.taskIds);
  const projectId = typeof payload.projectId === 'string' ? payload.projectId.trim() : '';
  return {
    ...(taskIds.length > 0 ? { taskIds } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

function downloadableTaskWhere(): Prisma.VideoTaskWhereInput {
  return {
    local_status: 'succeeded',
    retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] },
    OR: [
      { local_video_path: { not: null } },
      { result_video_url: { not: null } },
    ],
  };
}

export async function countDownloadableProjectTasks(projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, number>();
  const groups = await prisma.videoTask.groupBy({
    by: ['project_id'],
    where: {
      ...downloadableTaskWhere(),
      project_id: { in: projectIds },
    },
    _count: { _all: true },
  });

  return new Map(
    groups
      .filter((group): group is typeof group & { project_id: string } => Boolean(group.project_id))
      .map((group) => [group.project_id, group._count._all]),
  );
}

function validateScope(scope: BulkDownloadScope) {
  if (scope.projectId && scope.taskIds?.length) {
    throw new AuthError('一次只能选择项目范围或任务范围', 400);
  }
  if (!scope.projectId && !scope.taskIds?.length) {
    throw new AuthError('请选择要下载的视频任务或项目', 400);
  }
  if (scope.taskIds) {
    const uniqueIds = new Set(scope.taskIds);
    if (uniqueIds.size !== scope.taskIds.length) {
      throw new AuthError('任务列表包含重复 ID', 400);
    }
    if (scope.taskIds.length > BULK_VIDEO_DOWNLOAD_LIMIT) {
      throw new AuthError(`第一批最多支持 ${BULK_VIDEO_DOWNLOAD_LIMIT} 个视频即时打包`, 413);
    }
  }
}

async function loadTasksForScope(user: SessionUser, scope: BulkDownloadScope) {
  validateScope(scope);

  if (scope.projectId) {
    await assertCanViewProject(user, scope.projectId);
    const countByProject = await countDownloadableProjectTasks([scope.projectId]);
    const total = countByProject.get(scope.projectId) || 0;
    if (total > BULK_VIDEO_DOWNLOAD_LIMIT) {
      throw new AuthError(
        `该项目有 ${total} 个可下载视频，第一批即时打包最多支持 ${BULK_VIDEO_DOWNLOAD_LIMIT} 个`,
        413,
      );
    }

    return prisma.videoTask.findMany({
      where: {
        ...downloadableTaskWhere(),
        project_id: scope.projectId,
      },
      orderBy: [{ completed_at: 'desc' }, { created_at: 'desc' }],
      take: BULK_VIDEO_DOWNLOAD_LIMIT,
      select: taskSelect,
    });
  }

  const ids = scope.taskIds || [];
  const tasks = await prisma.videoTask.findMany({
    where: { id: { in: ids } },
    select: taskSelect,
  });
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return ids.flatMap((id) => {
    const task = taskById.get(id);
    return task ? [task] : [];
  });
}

function sanitizeFilePart(value: string | null | undefined, fallback: string) {
  const text = (value || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return text || fallback;
}

function shortTaskId(taskId: string) {
  return taskId.slice(0, 12);
}

function buildVideoFileName(task: BulkVideoTask, index: number) {
  const order = String(index + 1).padStart(3, '0');
  const projectName = task.project?.name || '未归属项目';
  const resolution = task.resolution || 'unknown';
  const duration = task.duration ? `${task.duration}s` : 'unknown';
  return [
    order,
    shortTaskId(task.id),
    sanitizeFilePart(projectName, 'project'),
    sanitizeFilePart(resolution, 'resolution'),
    sanitizeFilePart(duration, 'duration'),
  ].join('_') + '.mp4';
}

function formatCharge(task: BulkVideoTask) {
  const micros = task.provider_final_amount_micros ?? task.provider_official_amount_micros;
  if (micros !== null && micros !== undefined) {
    return formatAmountMicrosWithFixedCny(micros, task.provider_cost_currency);
  }
  const minor = task.provider_final_amount_minor ?? task.provider_official_amount_minor;
  if (minor !== null && minor !== undefined) {
    return formatAmountMinorWithFixedCny(minor, task.provider_cost_currency);
  }
  return '待官方确认';
}

function submitterName(task: BulkVideoTask) {
  return displayUserName(task.owner || task.user);
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildManifestCsv(items: BulkDownloadItem[]) {
  const headers = [
    '序号',
    '任务ID',
    '项目',
    '生成者',
    '创建时间',
    '完成时间',
    '分辨率',
    '秒数',
    '比例',
    '实际扣费',
    '提示词摘要',
    '文件名',
    '状态',
    '失败原因',
  ];
  const rows = items.map((item, index) => {
    const task = item.task;
    return [
      index + 1,
      item.taskId,
      task?.project?.name || (task ? '未归属项目' : ''),
      task ? submitterName(task) : '',
      task?.created_at.toISOString() || '',
      task?.completed_at ? task.completed_at.toISOString() : '',
      task?.resolution || '',
      task?.duration ?? '',
      task?.ratio || '',
      task ? formatCharge(task) : '',
      task?.prompt.slice(0, 240) || '',
      item.fileName,
      item.status === 'success' ? '成功' : '失败',
      item.errorMessage || '',
    ].map(csvCell).join(',');
  });

  return `\uFEFF${[headers.map(csvCell).join(','), ...rows].join('\n')}\n`;
}

async function fileSizeIfReady(absolutePath: string | null) {
  if (!absolutePath) return null;
  try {
    const info = await stat(absolutePath);
    return info.isFile() && info.size > 0 ? info.size : null;
  } catch {
    return null;
  }
}

async function prepareDownloadItem(task: BulkVideoTask, index: number): Promise<BulkDownloadItem> {
  const fileName = buildVideoFileName(task, index);
  const cached = await cacheTaskVideoToLocal(task);
  if (!cached.success || !cached.local_video_path) {
    return {
      task,
      taskId: task.id,
      status: 'failed',
      fileName,
      localVideoPath: null,
      absolutePath: null,
      fileSize: null,
      errorMessage: cached.message || cached.error || '视频缓存失败',
    };
  }

  const absolutePath = localPublicVideoPath(cached.local_video_path);
  const fileSize = await fileSizeIfReady(absolutePath);
  if (!absolutePath || !fileSize) {
    return {
      task,
      taskId: task.id,
      status: 'failed',
      fileName,
      localVideoPath: cached.local_video_path,
      absolutePath,
      fileSize,
      errorMessage: '本地视频文件不可读',
    };
  }

  return {
    task,
    taskId: task.id,
    status: 'success',
    fileName,
    localVideoPath: cached.local_video_path,
    absolutePath,
    fileSize,
    errorMessage: null,
  };
}

function buildZipFileName(scope: BulkDownloadScope) {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const scopeText = scope.projectId ? 'project' : 'tasks';
  return `seedance-videos-${scopeText}-${stamp}.zip`;
}

function createZipStream(items: BulkDownloadItem[]) {
  const archive = new ZipFile();
  items
    .filter((item) => item.status === 'success' && item.absolutePath)
    .forEach((item) => {
      archive.addFile(item.absolutePath as string, item.fileName, { compressionLevel: 9 });
    });
  archive.addBuffer(Buffer.from(buildManifestCsv(items), 'utf8'), 'manifest.csv');
  archive.end();

  return archive.outputStream;
}

export async function buildBulkVideoDownloadPackage(
  user: SessionUser,
  scope: BulkDownloadScope,
): Promise<BulkVideoDownloadResult> {
  let tasks: BulkVideoTask[];
  try {
    tasks = await loadTasksForScope(user, scope) as BulkVideoTask[];
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResult(error.status, {
        success: false,
        error: error.message,
        requires_background_job: error.status === 413,
        limit: BULK_VIDEO_DOWNLOAD_LIMIT,
      });
    }
    throw error;
  }

  if (tasks.length === 0) {
    return jsonResult(404, {
      success: false,
      error: '没有找到可下载的视频任务',
      limit: BULK_VIDEO_DOWNLOAD_LIMIT,
    });
  }

  const permissionCheckedTasks: BulkVideoTask[] = [];
  const deniedItems: BulkDownloadItem[] = [];

  for (const task of tasks) {
    try {
      await assertCanViewTask(user, task);
      permissionCheckedTasks.push(task);
    } catch (error) {
      deniedItems.push({
        task: null,
        taskId: task.id,
        status: 'failed',
        fileName: '',
        localVideoPath: null,
        absolutePath: null,
        fileSize: null,
        errorMessage: '无权下载此任务',
      });
    }
  }

  const preparedItems = await Promise.all(
    permissionCheckedTasks.map((task, index) => prepareDownloadItem(task, index)),
  );
  const items = [...preparedItems, ...deniedItems];
  const successCount = items.filter((item) => item.status === 'success').length;
  const failedCount = items.length - successCount;

  if (successCount === 0) {
    return jsonResult(400, {
      success: false,
      error: '没有可打包的视频',
      failures: items.map((item) => ({
        task_id: item.taskId,
        message: item.errorMessage,
      })),
    });
  }

  return {
    kind: 'zip',
    status: 200,
    fileName: buildZipFileName(scope),
    stream: createZipStream(items),
    summary: {
      total: items.length,
      success: successCount,
      failed: failedCount,
    },
  };
}
