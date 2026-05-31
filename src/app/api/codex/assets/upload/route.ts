import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateCodexVideoApi,
  CodexApiAuthError,
} from '@/lib/integrations/codex';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { uploadSiteAsset, validateSiteUploadInput } from '@/lib/assets/site-upload';
import {
  attachAssetToCodexReferenceImage,
  ReferenceImportError,
} from '@/lib/assets/reference-import';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const context = await authenticateCodexVideoApi(request);
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
    const uploadResult = await uploadSiteAsset(buffer, file.name, file.type, file.size, context.user.id);
    const reference = await attachAssetToCodexReferenceImage(
      {
        user: context.user,
        workspaceId,
        sourceRequestId: context.source.source_request_id,
        sourceLabel: context.source.source_label,
      },
      uploadResult.assetId,
    );

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
      referenceImageId: reference.referenceImageId,
      reference_image_id: reference.referenceImageId,
      workspaceAssetId: reference.workspaceAssetId,
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
