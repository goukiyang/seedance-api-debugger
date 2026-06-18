import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { uploadSiteAsset, validateSiteUploadInput } from '@/lib/assets/site-upload';
import { getOrCreateWorkspace, addAssetToWorkspace } from '@/lib/assets/workspace';
import { attachAssetToSiteReferenceImage, ReferenceImportError } from '@/lib/assets/reference-import';
import { getProjectForGeneration } from '@/lib/projects/permissions';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';

export const runtime = 'nodejs';
export const maxDuration = 60;

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function roleForMimeType(mimeType: string, requestedRole: string) {
  if (requestedRole) return requestedRole.slice(0, 80);
  if (mimeType.startsWith('video/')) return 'reference_video';
  if (mimeType.startsWith('audio/')) return 'reference_audio';
  return 'reference_image';
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    const validationError = validateSiteUploadInput(file);
    if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

    const projectId = cleanString(formData.get('project_id'));
    const videoCardId = cleanString(formData.get('video_card_id'));
    const canvasDocumentId = cleanString(formData.get('canvas_document_id')) || null;
    const canvasNodeId = cleanString(formData.get('canvas_node_id')) || null;
    const requestedRole = cleanString(formData.get('role'));

    if (!videoCardId) {
      return NextResponse.json({ error: '必须先选择视频卡，上传素材才能进入统一项目链路' }, { status: 400 });
    }
    const videoCard = await prisma.videoCard.findUnique({
      where: { id: videoCardId },
      select: { id: true, project_id: true },
    });
    if (!videoCard) return NextResponse.json({ error: '视频卡不存在' }, { status: 404 });
    if (projectId && projectId !== videoCard.project_id) {
      return NextResponse.json({ error: '视频卡不属于当前项目' }, { status: 400 });
    }

    const project = await getProjectForGeneration(user, videoCard.project_id);
    await assertCanGenerateInVideoCard(user, project.id, videoCard.id);

    if (canvasDocumentId) {
      const canvas = await prisma.canvasDocument.findUnique({
        where: { id: canvasDocumentId },
        select: { id: true, owner_user_id: true, project_id: true, status: true },
      });
      if (!canvas || canvas.status === 'deleted') return NextResponse.json({ error: '画布不存在' }, { status: 404 });
      if (user.role !== 'admin' && canvas.owner_user_id !== user.id) {
        return NextResponse.json({ error: '无权编辑此画布' }, { status: 403 });
      }
      if (canvas.project_id && canvas.project_id !== project.id) {
        return NextResponse.json({ error: '画布不属于当前项目' }, { status: 400 });
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const uploadResult = await uploadSiteAsset(buffer, file.name, file.type, file.size, user.id);
    const workspaceId = (await getOrCreateWorkspace(`ultimate-canvas:${project.id}:${videoCard.id}`, user.id)).id;
    const role = roleForMimeType(uploadResult.mimeType, requestedRole);

    let reference: {
      assetId: string;
      referenceImageId: string;
      workspaceAssetId: string;
      originalUrl: string;
      fileName: string;
    } | null = null;
    let workspaceAssetId: string | null = null;
    if (uploadResult.mimeType.startsWith('image/')) {
      reference = await attachAssetToSiteReferenceImage({
        user,
        workspaceId,
        projectId: project.id,
        sourceRequestId: canvasNodeId || null,
        sourceLabel: '无线画布上传',
        role,
        albumName: '无线画布上传素材',
        albumDescription: '无线画布上传并自动归档的参考素材',
        metadataSource: 'ultimate_canvas_upload',
      }, uploadResult.assetId);
      workspaceAssetId = reference.workspaceAssetId;
    } else {
      workspaceAssetId = await addAssetToWorkspace(workspaceId, uploadResult.assetId, role, user.id);
    }

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'ultimate_canvas_asset_upload',
        target_type: 'Asset',
        target_id: uploadResult.assetId,
        detail: JSON.stringify({
          project_id: project.id,
          video_card_id: videoCard.id,
          canvas_document_id: canvasDocumentId,
          canvas_node_id: canvasNodeId,
          workspace_id: workspaceId,
          workspace_asset_id: workspaceAssetId,
          reference_image_id: reference?.referenceImageId || null,
          mime_type: uploadResult.mimeType,
          is_publicly_reachable: uploadResult.isPubliclyReachable,
          storage_provider: uploadResult.storageProvider || null,
        }),
      },
    });

    return NextResponse.json({
      success: true,
      workspace_id: workspaceId,
      workspace_asset_id: workspaceAssetId,
      reference_image_id: reference?.referenceImageId || null,
      asset: {
        id: uploadResult.assetId,
        originalUrl: uploadResult.originalUrl,
        thumbnailUrl: uploadResult.thumbnailUrl,
        width: uploadResult.width,
        height: uploadResult.height,
        fileName: uploadResult.fileName,
        fileSize: uploadResult.fileSize,
        mimeType: uploadResult.mimeType,
        isPubliclyReachable: uploadResult.isPubliclyReachable,
        storageProvider: uploadResult.storageProvider || null,
        warning: uploadResult.publicUploadWarning || null,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ReferenceImportError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    console.error('[UltimateCanvasUpload] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    );
  }
}
