import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { getOrCreateWorkspace, addAssetToWorkspace } from '@/lib/assets/workspace';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { assertCanUseReferenceImage, uniquePreserveOrder } from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseParams(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', message: '请先登录' }, { status: 401 });
    }

    const task = await prisma.videoTask.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        prompt: true,
        generation_mode: true,
        ratio: true,
        duration: true,
        resolution: true,
        seed: true,
        generate_audio: true,
        return_last_frame: true,
        watermark: true,
        reference_image_ids: true,
        reference_image_urls: true,
        params_json: true,
        project_id: true,
        owner_user_id: true,
        user_id: true,
        retention_status: true,
      },
    });

    if (!task) {
      return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    }

    await assertCanViewTask(user, task);

    const tabId = request.headers.get('x-tab-id') || 'default';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);
    await prisma.workspaceAsset.deleteMany({ where: { workspace_id: workspaceId } });

    const taskParams = parseParams(task.params_json);
    const referenceImageIds = uniquePreserveOrder([
      ...parseJsonArray(task.reference_image_ids),
      ...(Array.isArray(taskParams.referenceImageIds)
        ? taskParams.referenceImageIds.filter((item): item is string => typeof item === 'string')
        : []),
    ]).slice(0, 9);

    const referenceImageUrls = parseJsonArray(task.reference_image_urls).slice(0, 9);
    let restoredReferences = 0;
    let skippedReferences = 0;

    if (referenceImageIds.length > 0) {
      for (const referenceImageId of referenceImageIds) {
        try {
          const image = await assertCanUseReferenceImage(user, referenceImageId);
          if (!image.asset_id) {
            skippedReferences += 1;
            continue;
          }
          await addAssetToWorkspace(
            workspaceId,
            image.asset_id,
            'reference_image',
            user.id,
            { referenceImageId: image.id, allowSharedAsset: true },
          );
          restoredReferences += 1;
        } catch {
          skippedReferences += 1;
        }
      }
    } else if (referenceImageUrls.length > 0) {
      const existingAssets = await prisma.asset.findMany({
        where: { original_url: { in: referenceImageUrls } },
        select: { id: true, original_url: true },
      });
      const assetByUrl = new Map(existingAssets.map((asset) => [asset.original_url, asset]));

      for (const url of referenceImageUrls) {
        const asset = assetByUrl.get(url);
        if (!asset) {
          skippedReferences += 1;
          continue;
        }
        await addAssetToWorkspace(
          workspaceId,
          asset.id,
          'reference_image',
          user.id,
          { allowSharedAsset: true },
        );
        restoredReferences += 1;
      }
    }

    return NextResponse.json({
      draft: {
        task_id: task.id,
        prompt: task.prompt,
        generation_mode: task.generation_mode,
        ratio: task.ratio || asString(taskParams.ratio, '16:9'),
        duration: task.duration ?? asNumber(taskParams.duration, 5),
        resolution: task.resolution || asString(taskParams.resolution, '480p'),
        seed: task.seed ?? asNumber(taskParams.seed, -1),
        generate_audio: true,
        return_last_frame: task.return_last_frame ?? asBool(taskParams.returnLastFrame, false),
        watermark: task.watermark ?? asBool(taskParams.watermark, false),
        resolution_approval_confirmed: asBool(taskParams.resolutionApprovalConfirmed, false),
        project_id: task.project_id,
      },
      workspace_id: workspaceId,
      restored_references: restoredReferences,
      skipped_references: skippedReferences,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: '权限不足', message: error.message }, { status: error.status });
    }
    console.error('[ReuseTask]', error);
    return NextResponse.json(
      { error: '复用任务失败', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
