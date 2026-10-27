import { toVideoTaskView, videoTaskViewSelect } from '@/lib/dto/video-task';
import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { getSession, AuthError } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { privateMultiviewTaskWhere } from '@/lib/video/multiview-task-privacy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 24;
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
type Cursor = { at: string; id: string };

function cursor(value: string | null): Cursor | null {
  if (!value || value.length > 300) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    const item = decoded as Record<string, unknown>;
    if (typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at))
      || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id)) return null;
    return { at: item.at, id: item.id };
  } catch { return null; }
}

function phase(status: unknown): 'waiting' | 'running' | 'success' | 'failed' | 'unconfirmed' {
  const value = typeof status === 'string' ? status.toLowerCase() : '';
  if (['succeeded', 'success', 'completed', 'done', 'finished', 'ready'].includes(value)) return 'success';
  if (['failed', 'error', 'failure', 'cancelled', 'canceled', 'aborted', 'rejected', 'timeout'].includes(value)) return 'failed';
  if (['running', 'processing', 'generating', 'in_progress', 'progress'].includes(value)) return 'running';
  if (['draft', 'pending', 'submitted', 'queued', 'waiting', 'init'].includes(value)) return 'waiting';
  return 'unconfirmed';
}

function iso(value: unknown) { return value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null; }
function numberOrNull(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
const deliveryLabels = { generating: '生成中', preparing: '已生成，正在准备稳定下载', ready: '稳定下载已就绪',
  failed: '稳定下载准备失败，可重试', unavailable: '视频暂未就绪' } as const;

export const GET = declaredRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
  try {
    const user = await getSession();
    if (!user) throw new AuthError('请先登录', 401);
    assertInternalOnly(user, '外部账号无权使用3D多视图生成。');
    const expectedOwner = request.headers.get('x-app-session-user');
    if (expectedOwner !== null && expectedOwner !== user.id) return json({ error: '账号已变化，请重新打开本人生成记录。' }, 409);
    const after = cursor(request.nextUrl.searchParams.get('cursor'));
    if (request.nextUrl.searchParams.has('cursor') && !after) return json({ error: '分页位置无效，请刷新生成记录。' }, 400);
    const pageWhere: Prisma.VideoTaskWhereInput = after ? { OR: [
      { created_at: { lt: new Date(after.at) } },
      { created_at: new Date(after.at), id: { lt: after.id } },
    ] } : {};
    const tasks = await prisma.videoTask.findMany({
      where: { AND: [
        { OR: [{ owner_user_id: user.id }, { owner_user_id: null, user_id: user.id }] },
        privateMultiviewTaskWhere(),
        { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } },
        pageWhere,
      ] },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      select: videoTaskViewSelect,
    });
    const visible = tasks.slice(0, PAGE_SIZE);
    const taskIds = visible.map(item => item.id);
    const saved = taskIds.length ? await prisma.multiviewWork.findMany({
      where: { owner_id: user.id, source_task_id: { in: taskIds }, removed_at: null,
        mutations: { some: { action: { in: ['create', 'save', 'branch'] } } } },
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
      select: { id: true, source_task_id: true, title: true, status: true, updated_at: true,
        mutations: { where: { action: { in: ['create', 'save', 'branch'] } }, select: { id: true }, take: 1 } },
    }) : [];
    const savedByTask = new Map<string, typeof saved[number]>();
    for (const work of saved) if (work.mutations.length && !savedByTask.has(work.source_task_id)) savedByTask.set(work.source_task_id, work);
    const items = visible.map(task => {
      const safe = toVideoTaskView(task, user) as unknown as Record<string, unknown>;
      const work = savedByTask.get(task.id);
      const project = safe.project && typeof safe.project === 'object' ? safe.project as Record<string, unknown> : null;
      const card = safe.video_card && typeof safe.video_card === 'object' ? safe.video_card as Record<string, unknown> : null;
      const delivery = safe.delivery_stage && typeof safe.delivery_stage === 'object'
        ? safe.delivery_stage as Record<string, unknown> : null;
      const deliveryKey = delivery && typeof delivery.key === 'string' && Object.hasOwn(deliveryLabels, delivery.key)
        ? delivery.key as keyof typeof deliveryLabels : null;
      return {
        id: task.id,
        status: phase(safe.local_status),
        deliveryStage: deliveryKey ? { key: deliveryKey, label: deliveryLabels[deliveryKey] } : null,
        provider: typeof safe.provider === 'string' ? safe.provider : null,
        model: typeof safe.model === 'string' ? safe.model : null,
        generationMode: typeof safe.generation_mode === 'string' ? safe.generation_mode : null,
        ratio: typeof safe.ratio === 'string' ? safe.ratio : null,
        duration: numberOrNull(safe.duration),
        resolution: typeof safe.resolution === 'string' ? safe.resolution : null,
        seed: numberOrNull(safe.seed),
        generateAudio: typeof safe.generate_audio === 'boolean' ? safe.generate_audio : null,
        returnLastFrame: typeof safe.return_last_frame === 'boolean' ? safe.return_last_frame : null,
        watermark: typeof safe.watermark === 'boolean' ? safe.watermark : null,
        estimatedCost: numberOrNull(safe.estimated_cost),
        frozenCost: numberOrNull(safe.frozen_cost),
        actualCost: numberOrNull(safe.actual_cost),
        project: project && typeof project.id === 'string' && typeof project.name === 'string' ? { id: project.id, name: project.name } : null,
        videoCard: card && typeof card.id === 'string' && typeof card.title === 'string' ? { id: card.id, title: card.title } : null,
        createdAt: iso(safe.created_at), updatedAt: iso(safe.updated_at), completedAt: iso(safe.completed_at),
        thumbnailUrl: typeof safe.thumbnail_url === 'string' ? safe.thumbnail_url : null,
        playUrl: typeof safe.play_url === 'string' ? safe.play_url : null,
        downloadUrl: typeof safe.download_url === 'string' ? safe.download_url : null,
        previewAvailable: safe.preview_available === true,
        stableDownloadReady: safe.stable_download_ready === true,
        error: typeof safe.error_message === 'string' ? { code: typeof safe.error_code === 'string' ? safe.error_code : 'GENERATION_NOT_COMPLETED', message: safe.error_message } : null,
        savedWork: work ? { id: work.id, title: work.title, status: work.status, updatedAt: work.updated_at.toISOString() } : null,
      };
    });
    const last = visible.at(-1);
    return json({ items, pageSize: PAGE_SIZE, nextCursor: tasks.length > PAGE_SIZE && last
      ? Buffer.from(JSON.stringify({ at: last.created_at.toISOString(), id: last.id })).toString('base64url') : null });
  } catch (error) {
    if (error instanceof AuthError) return json({ error: error.message }, error.status);
    return json({ error: '本人生成记录暂时无法读取，请稍后重试。' }, 503);
  }
});
