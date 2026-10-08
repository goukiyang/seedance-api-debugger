import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { readCanvasStyleJson } from '@/lib/canvas-style-bridge';
import { assertCanEditCanvasDocument } from '@/lib/canvas-documents';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { uploadSiteAsset, validateSiteUploadBuffer, validateSiteUploadInput } from '@/lib/assets/site-upload';
import { getOrCreateWorkspace, addAssetToWorkspace } from '@/lib/assets/workspace';
import { attachAssetToSiteReferenceImage, ReferenceImportError } from '@/lib/assets/reference-import';
import { getProjectForGeneration } from '@/lib/projects/permissions';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MULTIPART_COMPAT_MAX_SIZE_BYTES = 8 * 1024 * 1024;

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function roleForMimeType(mimeType: string, requestedRole: string) {
  if (requestedRole) return requestedRole.slice(0, 80);
  if (mimeType.startsWith('video/')) return 'reference_video';
  if (mimeType.startsWith('audio/')) return 'reference_audio';
  return 'reference_image';
}

function parseContentLength(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权使用无限画布上传。');

    const jsonAssociation = request.headers.get('content-type')?.includes('application/json') === true;
    const multipartContentLength = parseContentLength(request.headers.get('content-length'));
    if (!jsonAssociation && multipartContentLength == null) {
      return NextResponse.json(
        { error: '当前旧版表单上传缺少文件大小信息，请刷新页面后使用新版上传链路。' },
        { status: 411 },
      );
    }
    if (!jsonAssociation && multipartContentLength != null && multipartContentLength > MULTIPART_COMPAT_MAX_SIZE_BYTES) {
      return NextResponse.json(
        { error: '当前上传入口只兼容 8MB 以内旧版表单上传，请刷新页面后使用新版上传链路。' },
        { status: 413 },
      );
    }
    if (jsonAssociation && multipartContentLength != null && multipartContentLength > 16384) return NextResponse.json({ error: '关联请求过大' }, { status: 413 });
    const json = jsonAssociation ? await readCanvasStyleJson(request) : null;
    const formData = jsonAssociation ? null : await request.formData();
    const field = (name: string) => jsonAssociation ? json?.[name] : formData?.get(name);
    const file = formData?.get('file') as File | null;
    if (!jsonAssociation && !file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    if (file) {
      const validationError = validateSiteUploadInput(file);
      if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const projectId = cleanString(field('project_id'));
    const videoCardId = cleanString(field('video_card_id'));
    const canvasDocumentId = cleanString(field('canvas_document_id')) || null;
    const canvasNodeId = cleanString(field('canvas_node_id')) || null;
    const requestedRole = cleanString(field('role'));
    const requestId = cleanString(field('request_id'));
    const assetId = cleanString(field('asset_id'));
    const validId = (id: string | null) => Boolean(id && /^[a-zA-Z0-9_-]{1,160}$/.test(id));
    if (jsonAssociation && ![requestId, assetId, projectId, videoCardId, canvasDocumentId, canvasNodeId].every(validId)) {
      return NextResponse.json({ error: '关联目标或原素材编号无效，请重新打开画布' }, { status: 400 });
    }

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
      await assertCanEditCanvasDocument(user, canvasDocumentId, project.id);
      const canvas = await prisma.canvasDocument.findUnique({
        where: { id: canvasDocumentId },
        select: { id: true, owner_user_id: true, project_id: true, status: true },
      });
      if (!canvas || canvas.status === 'deleted') return NextResponse.json({ error: '画布不存在' }, { status: 404 });
      if (canvas.project_id && canvas.project_id !== project.id) {
        return NextResponse.json({ error: '画布不属于当前项目' }, { status: 400 });
      }
      if (user.role !== 'admin' && canvas.owner_user_id !== user.id && !canvas.project_id) {
        return NextResponse.json({ error: '无权编辑此画布' }, { status: 403 });
      }
    }

    // JSON associates a confirmed original; it never fetches or copies a client URL.
    const existingAsset = jsonAssociation ? await prisma.asset.findUnique({ where: { id: assetId } }) : null;
    if (jsonAssociation && (!existingAsset || existingAsset.owner_id !== user.id || existingAsset.status !== 'active'
      || !['image', 'video', 'audio'].includes(existingAsset.type))) {
      return NextResponse.json({ error: '原素材不存在或无权关联' }, { status: 403 });
    }
    let uploadResult;
    if (existingAsset) {
      uploadResult = { assetId: existingAsset.id, originalUrl: existingAsset.original_url,
        thumbnailUrl: existingAsset.thumbnail_url, width: existingAsset.width, height: existingAsset.height,
        fileName: existingAsset.file_name, fileSize: existingAsset.file_size, mimeType: existingAsset.mime_type,
        isPubliclyReachable: false, storageProvider: null, publicUploadWarning: null };
    } else {
      const sourceFile = file!;
      const buffer = Buffer.from(await sourceFile.arrayBuffer());
      const mediaValidationError = await validateSiteUploadBuffer(buffer, sourceFile.name, sourceFile.type);
      if (mediaValidationError) return NextResponse.json({ error: mediaValidationError }, { status: 400 });
      uploadResult = await uploadSiteAsset(buffer, sourceFile.name, sourceFile.type, sourceFile.size, user.id);
    }
    const workspaceId = (await getOrCreateWorkspace(`ultimate-canvas:${project.id}:${videoCard.id}`, user.id)).id;
    const role = roleForMimeType(uploadResult.mimeType, jsonAssociation ? '' : requestedRole);

    const associate = async (db: Prisma.TransactionClient) => {
    if (jsonAssociation && existingAsset) {
      const fresh = await db.asset.findUnique({ where: { id: assetId } });
      if (!fresh || fresh.owner_id !== user.id || fresh.status !== 'active') throw new AuthError('原素材不存在或无权关联', 403);
      const prior = await db.operationLog.findFirst({ where: { operator_id: user.id, action: 'ultimate_canvas_asset_upload',
        detail: { contains: `"request_id":"${requestId}"` } } });
      if (prior) {
        const detail = JSON.parse(prior.detail || '{}');
        if (prior.target_id !== assetId || detail.request_id !== requestId || detail.project_id !== project.id
          || detail.video_card_id !== videoCard.id || detail.canvas_document_id !== canvasDocumentId || detail.canvas_node_id !== canvasNodeId) {
          throw new AuthError('关联编号已用于其它目标，未修改原素材', 409);
        }
        return { success: true, workspace_id: detail.workspace_id, workspace_asset_id: detail.workspace_asset_id,
          reference_image_id: detail.reference_image_id, asset: { id: fresh.id, originalUrl: fresh.original_url,
            thumbnailUrl: fresh.thumbnail_url, width: fresh.width, height: fresh.height,
            fileName: fresh.file_name, fileSize: fresh.file_size, mimeType: fresh.mime_type } };
      }
    }
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
        sourceLabel: '无限画布上传',
        role,
        albumName: '无限画布上传素材',
        albumDescription: '无限画布上传并自动归档的参考素材',
        metadataSource: 'ultimate_canvas_upload',
        db,
      }, uploadResult.assetId);
      workspaceAssetId = reference.workspaceAssetId;
    } else {
      workspaceAssetId = await addAssetToWorkspace(workspaceId, uploadResult.assetId, role, user.id, { db });
    }

    await db.operationLog.create({
      data: {
        ...(jsonAssociation ? { id: `canvas-association-${createHash('sha256').update(`${user.id}:${requestId}`).digest('hex')}` } : {}),
        operator_id: user.id,
        action: 'ultimate_canvas_asset_upload',
        target_type: 'Asset',
        target_id: uploadResult.assetId,
        detail: JSON.stringify({
          project_id: project.id,
          video_card_id: videoCard.id,
          canvas_document_id: canvasDocumentId,
          canvas_node_id: canvasNodeId,
          request_id: requestId || null,
          workspace_id: workspaceId,
          workspace_asset_id: workspaceAssetId,
          reference_image_id: reference?.referenceImageId || null,
          mime_type: uploadResult.mimeType,
          is_publicly_reachable: uploadResult.isPubliclyReachable,
          storage_provider: uploadResult.storageProvider || null,
        }),
      },
    });

    return {
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
    };
    };
    // Association and its receipt commit together. Concurrent retries cannot create a second association.
    return NextResponse.json(jsonAssociation ? await prisma.$transaction(associate) : await associate(prisma));
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

// Unknown upload responses are resolved by an exact owned-file identity, never by reposting bytes.
export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertInternalOnly(user, '外部账号无权使用无限画布上传。');
    const query = request.nextUrl.searchParams;
    const documentId = query.get('canvas_document_id') || '';
    const projectId = query.get('project_id') || '';
    const cardId = query.get('video_card_id') || '';
    const hash = query.get('hash') || '';
    const mimeType = query.get('mime_type') || '';
    const fileSize = Number(query.get('file_size'));
    if (![documentId, projectId, cardId].every(id => /^[a-zA-Z0-9_-]{1,160}$/.test(id)) || !/^[a-f0-9]{64}$/.test(hash)
      || !Number.isSafeInteger(fileSize) || fileSize <= 0 || !/^(image|video|audio)\//.test(mimeType)) {
      return NextResponse.json({ error: '恢复目标或文件身份无效' }, { status: 400 });
    }
    await getProjectForGeneration(user, projectId);
    await assertCanGenerateInVideoCard(user, projectId, cardId);
    await assertCanEditCanvasDocument(user, documentId, projectId);
    const asset = await prisma.asset.findFirst({ where: { owner_id: user.id, hash, file_size: fileSize, mime_type: mimeType, status: 'active' } });
    return NextResponse.json({ found: Boolean(asset), asset: asset ? { id: asset.id, originalUrl: asset.original_url,
      thumbnailUrl: asset.thumbnail_url, width: asset.width, height: asset.height, fileName: asset.file_name,
      fileSize: asset.file_size, mimeType: asset.mime_type, hash: asset.hash } : null });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: '上传恢复暂不可用，未重新上传' }, { status: 500 });
  }
}
