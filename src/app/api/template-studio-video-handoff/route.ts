import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { attachAssetToSiteReferenceImage, ReferenceImportError } from '@/lib/assets/reference-import';
import { ensureSiteAssetPublicUrl } from '@/lib/assets/site-upload';
import { authorizeStudioRunForGeneration } from '@/lib/template-studio/handoff';
import { requireStudioUser } from '@/lib/template-studio/common';
import { studioErrorResponse } from '@/lib/template-studio/errors';
import { buildAcceptedTaskLookupWhere, isStudioHandoffWorkspaceInitialized } from '@/lib/template-studio-video-handoff';

export const dynamic = 'force-dynamic';

function studioWorkspaceTabId(runId: string) {
  return `template-studio-${runId}`;
}

export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录', code: 'UNAUTHENTICATED' }, { status: 401 });
  try {
    requireStudioUser(user);
  } catch (error) {
    return studioErrorResponse(error);
  }

  let body: { runId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求内容无效', code: 'INVALID' }, { status: 400 });
  }
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!runId || runId.length > 200) {
    return NextResponse.json({ error: '模板运行记录编号无效', code: 'INVALID' }, { status: 400 });
  }

  let handoff;
  try {
    handoff = await authorizeStudioRunForGeneration(user, runId);
  } catch (error) {
    const candidateStatus = error && typeof error === 'object' && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : 0;
    const status = [403, 404, 409].includes(candidateStatus) ? candidateStatus : 404;
    return NextResponse.json({ error: '模板运行记录不存在、已撤权或素材不可用', code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND' }, { status });
  }

  const seen = new Map<string, { role: string; type: string; slotKey: string }>();
  for (const item of handoff.assets) {
    const previous = seen.get(item.assetId);
    const slotKey = 'slotKey' in item && typeof item.slotKey === 'string' ? item.slotKey : '';
    if (previous && (previous.role !== item.role || previous.type !== item.type || previous.slotKey !== slotKey)) {
      return NextResponse.json({ error: '同一素材被分配到多个不兼容槽位，无法安全恢复', code: 'CONFLICT' }, { status: 409 });
    }
    seen.set(item.assetId, { role: item.role, type: item.type, slotKey });
  }

  const assetIds = Array.from(seen.keys());
  const assets = await prisma.asset.findMany({
    where: { id: { in: assetIds }, status: 'active' },
    select: { id: true, type: true },
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  if (assets.length !== assetIds.length || handoff.assets.some((item) => assetById.get(item.assetId)?.type !== item.type)) {
    return NextResponse.json({ error: '模板素材已失效或无权访问', code: 'FORBIDDEN' }, { status: 403 });
  }
  if (handoff.assets.some((item) => (item.role === 'first' || item.role === 'last') && item.type !== 'image')) {
    return NextResponse.json({ error: '首帧和尾帧槽位只支持图片素材', code: 'INVALID' }, { status: 400 });
  }

  const workspaceTabId = studioWorkspaceTabId(runId);
  const { id: workspaceId } = await getOrCreateWorkspace(workspaceTabId, user.id);
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { created_at: true, updated_at: true },
  });
  if (!workspace) return NextResponse.json({ error: '生成工作区不可用，请稍后重试', code: 'UNAVAILABLE' }, { status: 503 });

  // This run-scoped workspace marker distinguishes interrupted initialization from later user removals.
  const handoffInitialized = isStudioHandoffWorkspaceInitialized(workspace.created_at, workspace.updated_at);
  if (!handoffInitialized) {
    try {
      const assetIdsForRun = handoff.assets.map((item) => item.assetId);
      const [existingRows, otherRows] = await Promise.all([
        prisma.workspaceAsset.findMany({
          where: { workspace_id: workspaceId, asset_id: { in: assetIdsForRun } },
          select: { id: true, asset_id: true },
        }),
        prisma.workspaceAsset.findMany({
          where: { workspace_id: workspaceId, ...(assetIdsForRun.length ? { asset_id: { notIn: assetIdsForRun } } : {}) },
          select: { sort_order: true },
        }),
      ]);
      const existingAssetIds = new Set(existingRows.map((row) => row.asset_id));
      let anotherRequestFinishedInitialization = false;

      for (const item of handoff.assets) {
        const currentWorkspace = await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { created_at: true, updated_at: true },
        });
        if (!currentWorkspace) throw new Error('workspace unavailable');
        if (isStudioHandoffWorkspaceInitialized(currentWorkspace.created_at, currentWorkspace.updated_at)) {
          anotherRequestFinishedInitialization = true;
          break;
        }
        if (existingAssetIds.has(item.assetId)) continue;
        if (item.role === 'reference' && item.type === 'image') {
          await attachAssetToSiteReferenceImage({
            user,
            workspaceId,
            sourceLabel: '模板工作台视频生成',
            role: 'reference_image',
            albumName: '模板工作台生成参考图',
            albumDescription: '模板运行记录恢复到普通视频生成工作台的参考图',
            metadataSource: 'template_studio_video_handoff',
            allowSharedAsset: true,
          }, item.assetId);
          existingAssetIds.add(item.assetId);
          continue;
        }

        let role = item.role === 'first'
          ? 'first_frame'
          : item.role === 'last'
            ? 'last_frame'
            : item.type === 'video'
              ? 'reference_video'
              : item.type === 'audio'
                ? 'reference_audio'
                : 'reference_image';
        if (item.type === 'video' || item.type === 'audio') {
          const publicUrl = await ensureSiteAssetPublicUrl(item.assetId);
          if (!publicUrl.isPubliclyReachable) {
            throw new ReferenceImportError('模板中的视频或音频素材当前无法公网访问', 400, 'reference_media_url_not_public');
          }
        }
        try {
          await prisma.workspaceAsset.create({
            data: { workspace_id: workspaceId, asset_id: item.assetId, role },
          });
          existingAssetIds.add(item.assetId);
        } catch (error) {
          const racedRow = await prisma.workspaceAsset.findUnique({
            where: { workspace_id_asset_id: { workspace_id: workspaceId, asset_id: item.assetId } },
            select: { id: true },
          });
          if (!racedRow) throw error;
          existingAssetIds.add(item.assetId);
        }
      }

      const latestWorkspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { created_at: true, updated_at: true },
      });
      if (!latestWorkspace) return NextResponse.json({ error: '生成工作区不可用，请稍后重试', code: 'UNAVAILABLE' }, { status: 503 });
      if (anotherRequestFinishedInitialization
        || isStudioHandoffWorkspaceInitialized(latestWorkspace.created_at, latestWorkspace.updated_at)) {
        return NextResponse.json({ handoff, workspaceTabId });
      }

      const rows = await prisma.workspaceAsset.findMany({
        where: { workspace_id: workspaceId, asset_id: { in: assetIdsForRun } },
        select: { id: true, asset_id: true },
      });
      const inputOrder = new Map(handoff.assets.map((item, index) => [item.assetId, index]));
      if (rows.length !== assetIdsForRun.length) {
        return NextResponse.json({ error: '模板素材仍在恢复，请稍后重试', code: 'HANDOFF_ASSETS_PENDING' }, { status: 503 });
      }
      const baseSortOrder = Math.max(-1, ...otherRows.map((row) => row.sort_order)) + 1;
      await Promise.all(rows.map((row) => prisma.workspaceAsset.update({
        where: { id: row.id },
        data: { sort_order: baseSortOrder + (inputOrder.get(row.asset_id) ?? 0) },
      })));
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { updated_at: new Date(Math.max(Date.now(), workspace.created_at.getTime() + 1)) },
      });
    } catch (error) {
      if (error instanceof ReferenceImportError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      }
      return NextResponse.json({ error: '模板素材准备失败，请稍后重试', code: 'UNAVAILABLE' }, { status: 503 });
    }
  }

  return NextResponse.json({ handoff, workspaceTabId });
}

export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录', code: 'UNAUTHENTICATED' }, { status: 401 });
  try {
    requireStudioUser(user);
  } catch (error) {
    return studioErrorResponse(error);
  }

  const key = request.nextUrl.searchParams.get('idempotency_key')?.trim() || '';
  const runId = request.nextUrl.searchParams.get('template_studio_run_id')?.trim() || '';
  if (!key || key.length > 200 || !runId || runId.length > 200) {
    return NextResponse.json({ error: '请求号无效', code: 'INVALID' }, { status: 400 });
  }

  const task = await prisma.videoTask.findFirst({
    where: {
      ...buildAcceptedTaskLookupWhere(user.id, key, runId),
    },
    select: {
      id: true,
      provider: true,
      provider_task_id: true,
      model: true,
      local_status: true,
      created_at: true,
      project_id: true,
      video_card_id: true,
      template_id: true,
      agent_run_id: true,
      selected_agent_plan_key: true,
      estimated_cost: true,
      frozen_cost: true,
      is_draft: true,
      template_studio_run_id: true,
    },
  });

  return NextResponse.json({ task: task ? {
    id: task.id,
    provider: task.provider,
    provider_task_id: task.provider_task_id,
    model: task.model,
    status: task.local_status,
    created_at: task.created_at,
    project_id: task.project_id,
    video_card_id: task.video_card_id,
    template_id: task.template_id,
    agent_run_id: task.agent_run_id,
    selected_agent_plan_key: task.selected_agent_plan_key,
    estimated_cost: task.estimated_cost,
    frozen_cost: task.frozen_cost,
    is_draft: task.is_draft,
    template_studio_run_id: task.template_studio_run_id,
    deduplicated: true,
  } : null });
}
