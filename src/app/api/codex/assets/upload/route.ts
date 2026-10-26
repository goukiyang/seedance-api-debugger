import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateCodexVideoApi,
  CodexApiAuthError,
} from '@/lib/integrations/codex';
import { addAssetToWorkspace, getOrCreateWorkspace } from '@/lib/assets/workspace';
import { uploadSiteAsset, validateSiteUploadBuffer, validateSiteUploadInput } from '@/lib/assets/site-upload';
import {
  attachAssetToCodexReferenceImage,
  ReferenceImportError,
} from '@/lib/assets/reference-import';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const MULTIPART_COMPAT_MAX_SIZE_BYTES = 8 * 1024 * 1024;

function roleForMimeType(mimeType: string) {
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
    const context = await authenticateCodexVideoApi(request);
    const multipartContentLength = parseContentLength(request.headers.get('content-length'));
    if (multipartContentLength == null) {
      return NextResponse.json(
        { error: 'codex_asset_upload_length_required', message: '当前旧版表单上传缺少文件大小信息，请改用新版原始文件上传链路。' },
        { status: 411 },
      );
    }
    if (multipartContentLength != null && multipartContentLength > MULTIPART_COMPAT_MAX_SIZE_BYTES) {
      return NextResponse.json(
        { error: 'codex_asset_upload_too_large', message: '当前上传入口只兼容 8MB 以内旧版表单上传，请改用新版原始文件上传链路。' },
        { status: 413 },
      );
    }
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const validationError = validateSiteUploadInput(file);
    if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

    const tabId = request.headers.get('x-tab-id') || 'codex';
    const { id: workspaceId } = await getOrCreateWorkspace(tabId, context.user.id);
    const buffer = Buffer.from(await file.arrayBuffer());
    const mediaValidationError = await validateSiteUploadBuffer(buffer, file.name, file.type);
    if (mediaValidationError) return NextResponse.json({ error: mediaValidationError }, { status: 400 });

    const uploadResult = await uploadSiteAsset(buffer, file.name, file.type, file.size, context.user.id);
    const role = roleForMimeType(uploadResult.mimeType);
    const reference = uploadResult.mimeType.startsWith('image/')
      ? await attachAssetToCodexReferenceImage(
          {
            user: context.user,
            workspaceId,
            sourceRequestId: context.source.source_request_id,
            sourceLabel: context.source.source_label,
          },
          uploadResult.assetId,
        )
      : null;
    const workspaceAssetId = reference?.workspaceAssetId
      || await addAssetToWorkspace(workspaceId, uploadResult.assetId, role, context.user.id);

    return NextResponse.json({
      success: true,
      workspaceId,
      asset: {
        id: uploadResult.assetId,
        originalUrl: uploadResult.originalUrl,
        thumbnailUrl: uploadResult.thumbnailUrl,
        width: uploadResult.width,
        height: uploadResult.height,
        fileName: uploadResult.fileName,
        fileSize: uploadResult.fileSize,
        mimeType: uploadResult.mimeType,
        hash: uploadResult.hash,
        isPubliclyReachable: uploadResult.isPubliclyReachable,
        storageProvider: uploadResult.storageProvider,
        warning: uploadResult.publicUploadWarning,
      },
      referenceImageId: reference?.referenceImageId || null,
      reference_image_id: reference?.referenceImageId || null,
      workspaceAssetId,
      role,
      source_type: context.source.source_type,
      source_label: context.source.source_label,
      source_request_id: context.source.source_request_id,
    });
  } catch (error) {
    if (error instanceof CodexApiAuthError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof ReferenceImportError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    console.error('[CodexAssetUpload] Failed:', error);
    return NextResponse.json(
      { error: 'codex_asset_upload_failed', message: error instanceof Error ? error.message : 'Codex 素材上传失败' },
      { status: 500 },
    );
  }
}
