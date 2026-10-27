import { route as apiRoute } from '@/lib/http/route';
import { readMultipartUpload, streamToTemporaryUpload, UploadStreamError } from '@/lib/assets/streamed-upload';
/**
 * POST /api/assets/upload
 * 上传单个文件（图片/视频/音频）
 * - 优先使用公网上传（R2/TOS），返回公网 HTTPS URL
 * - 回退本地存储（development / 未配置公网存储时）
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { randomUUID } from 'node:crypto';
import { assertUploadOwner, privateUploadDirectory, uploadIdentity, uploadRequestId, verifiedUploadFailure, VerifiedUploadError } from '@/lib/assets/verified-upload';
import { claimLegacyRawUpload, rawUploadIdentity, rawUploadProof, rawUploadRecoveryToken, readRawUploadResult, readRawUploadState, transitionRawUpload, type RawUploadIdentity } from '@/lib/assets/raw-upload-state';
import {
  getSiteUploadKind,
  uploadSiteAssetFile,
  validateSiteUploadMetadata,
} from '@/lib/assets/site-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';
import { requestHd } from '@/lib/media/hd-derivatives';
import { browserUploadResponse } from '@/lib/media/browser-projection.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const MULTIPART_COMPAT_MAX_SIZE_BYTES = 8 * 1024 * 1024;

// Read the original receipt and preparation state without changing either.
// Absence alone never proves that the original request was not accepted.
export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);
    await uploadIdentity(user.id);
    const query = request.nextUrl.searchParams;
    const identity = rawUploadIdentity(user.id, { requestId: query.get('requestId'), hash: query.get('hash'), fileSize: query.get('fileSize'), mimeType: query.get('mimeType') });
    const asset = await readRawUploadResult(identity);
    if (asset) return NextResponse.json(await browserUploadResponse(user, { success: true, asset }), { headers: { 'Cache-Control': 'private, no-store' } });
    const state = await readRawUploadState(identity);
    return NextResponse.json({ rawUpload: state ? rawUploadProof(state) : { ...identity, phase: 'absent' }, recoveryToken: await rawUploadRecoveryToken(identity) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof VerifiedUploadError) return NextResponse.json({ ...verifiedUploadFailure(error), errorStage: 'recovery' }, { status: error.status });
    return NextResponse.json({ error: '原上传结果暂时无法核对，请稍后查询；未重新发送文件' }, { status: 503 });
  }
});

type UploadPayload = {
  file: string;
  hash: string;
  cleanup: () => Promise<void>;
  fileName: string;
  mimeType: string;
  fileSize: number;
};

function decodeFileName(value: string | null) {
  if (!value) return 'upload.bin';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseContentLength(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function readUploadPayload(request: NextRequest): Promise<
  | { payload: UploadPayload; response?: never }
  | { payload?: never; response: NextResponse }
> {
  const contentTypeHeader = request.headers.get('content-type') || '';
  const contentType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() || '';

  if (contentTypeHeader.toLowerCase().includes('multipart/form-data')) {
    const multipartContentLength = parseContentLength(request.headers.get('content-length'));
    if (multipartContentLength == null) {
      return {
        response: NextResponse.json(
          { error: '当前旧版表单上传缺少文件大小信息，请刷新页面后使用新版上传链路。' },
          { status: 411 },
        ),
      };
    }
    if (multipartContentLength != null && multipartContentLength > MULTIPART_COMPAT_MAX_SIZE_BYTES) {
      return {
        response: NextResponse.json(
          { error: '当前上传入口只兼容 8MB 以内旧版表单上传，请刷新页面后使用新版上传链路。' },
          { status: 413 },
        ),
      };
    }
    const received = await readMultipartUpload(request, multipartContentLength, MULTIPART_COMPAT_MAX_SIZE_BYTES);
    const validationError = validateSiteUploadMetadata({ mimeType: received.mimeType, fileSize: received.fileSize });
    if (validationError) { await received.cleanup(); return { response: NextResponse.json({ error: validationError }, { status: 400 }) }; }
    return { payload: received };
  }

  const fileName = decodeFileName(request.headers.get('x-file-name'));
  const declaredSize = parseContentLength(
    request.headers.get('x-file-size') || request.headers.get('content-length'),
  );

  const metadataError = validateSiteUploadMetadata({
    mimeType: contentType,
    fileSize: declaredSize ?? 0,
  });
  if (metadataError) {
    return { response: NextResponse.json({ error: metadataError }, { status: 400 }) };
  }

  if (!request.body) throw new VerifiedUploadError('UPLOAD_BODY_MISSING', '没有收到上传文件', 400);
  const received = await streamToTemporaryUpload(request.body, { expectedBytes: declaredSize!, maxBytes: declaredSize!, signal: request.signal });
  return { payload: { ...received, fileName, mimeType: contentType, fileSize: received.bytes } };
}

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let fileName: string | null = decodeFileName(request.headers.get('x-file-name'));
  let mimeType: string | null = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || null;
  let fileSize: number | null = parseContentLength(request.headers.get('x-file-size') || request.headers.get('content-length'));
  let temporary: UploadPayload | undefined;
  let receiving: { identity: RawUploadIdentity; nonce: string } | null = null;
  let originalRequestId: string | null = null;
  let errorStage = 'validation';
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);
    await uploadIdentity(user.id);
    const requestId = uploadRequestId(request.headers.get('x-upload-request-id'));
    originalRequestId = requestId || null;
    const suppliedNonce = request.headers.get('x-raw-upload-nonce');
    const preparedRequest = suppliedNonce !== null || request.headers.get('x-raw-upload-version') !== null;
    if (preparedRequest) {
      if (request.headers.get('x-raw-upload-version') !== '2' || !suppliedNonce || !/^[a-f0-9]{48}$/.test(suppliedNonce)) throw new VerifiedUploadError('UPLOAD_PREPARATION_REQUIRED', '原上传准备信息无法确认，未接收文件', 409);
      const identity = rawUploadIdentity(user.id, { requestId, hash: request.headers.get('x-file-hash'), fileSize, mimeType });
      const asset = await readRawUploadResult(identity);
      if (asset) return NextResponse.json(await browserUploadResponse(user, { success: true, asset }), { headers: { 'Cache-Control': 'private, no-store' } });
      await transitionRawUpload(identity, suppliedNonce, 'prepared', 'receiving');
      receiving = { identity, nonce: suppliedNonce };
    }

    errorStage = 'receiving';
    const upload = await readUploadPayload(request);
    if (upload.response) {
      if (receiving) {
        const state = await transitionRawUpload(receiving.identity, receiving.nonce, 'receiving', 'notAccepted');
        return NextResponse.json({ error: '文件校验未通过，尚未保存；请重新选择后重试', code: 'RAW_UPLOAD_NOT_ACCEPTED', notAccepted: true,
          rawUpload: rawUploadProof(state) }, { status: upload.response.status });
      }
      return upload.response;
    }

    temporary = upload.payload;
    ({ fileName, mimeType, fileSize } = upload.payload);
    const { file, hash } = upload.payload;
    const identity = rawUploadIdentity(user.id, { requestId: requestId || randomUUID(), hash, fileSize, mimeType });
    originalRequestId = identity.requestId;
    if (receiving) {
      if (identity.hash !== receiving.identity.hash || identity.fileSize !== receiving.identity.fileSize || identity.mimeType !== receiving.identity.mimeType) {
        throw new VerifiedUploadError('UPLOAD_HASH_MISMATCH', '实际上传内容与原准备信息不一致，尚未保存', 400);
      }
    } else {
      const asset = await readRawUploadResult(identity);
      if (asset) return NextResponse.json(await browserUploadResponse(user, { success: true, asset }), { headers: { 'Cache-Control': 'private, no-store' } });
      const claim = await claimLegacyRawUpload(identity);
      receiving = { identity, nonce: claim.nonce };
    }
    // Only this still-receiving nonce can prove that no persistent upload work
    // has started. Storage/staging/publishing re-check the directory afterward;
    // a later failure must remain writing/unknown, never be unlocked here.
    errorStage = 'private-directory';
    try { await privateUploadDirectory(); }
    catch (error) {
      if (!(error instanceof VerifiedUploadError)
        || !['UPLOAD_PRIVATE_DIRECTORY_INVALID', 'UPLOAD_DATA_MOUNT_REQUIRED', 'UPLOAD_CAPACITY_GUARD'].includes(error.code)) throw error;
      let state: Awaited<ReturnType<typeof transitionRawUpload>>;
      try { state = await transitionRawUpload(identity, receiving.nonce, 'receiving', 'notAccepted'); }
      catch { throw new VerifiedUploadError('UPLOAD_RESULT_UNKNOWN', '原上传状态已变化，结果尚未确认；未重新发送文件', 409); }
      await recordAssetUploadLog({ operatorId: user.id, stage: 'raw', status: 'failed', fileName, mimeType, fileSize,
        durationMs: Date.now() - startedAt, errorCode: error.code, errorMessage: error.message,
        errorStage, requestId: identity.requestId, uploadMode: 'raw', fallbackPath: 'raw', skippedProxy: true });
      return NextResponse.json({ ...verifiedUploadFailure(error), code: 'RAW_UPLOAD_NOT_ACCEPTED', causeCode: error.code,
        errorStage, notAccepted: true, rawUpload: rawUploadProof(state) }, { status: error.status });
    }
    errorStage = 'writing';
    await transitionRawUpload(identity, receiving.nonce, 'receiving', 'writing');
    // Once writing has been acquired, no failure may declare notAccepted.
    const writing = receiving;
    receiving = null;
    const uploadResult = await uploadSiteAssetFile(file, fileName, mimeType, fileSize, hash, user.id, identity.requestId);
    await transitionRawUpload(identity, writing.nonce, 'writing', 'completed').catch(() => {});
    if (mimeType.startsWith('image/')) void prisma.asset.findFirst({
      where: { id: uploadResult.assetId, owner_id: user.id, status: 'active', type: 'image' },
      select: { id: true, owner_id: true, original_url: true },
    }).then(asset => asset && requestHd(asset.original_url, 0, undefined, undefined,
      { owner: { kind: 'asset', id: asset.id, ownerId: asset.owner_id } })).catch(() => {});

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'raw',
      status: uploadResult.reused ? 'reused' : 'succeeded',
      assetId: uploadResult.assetId,
      fileName,
      mimeType,
      fileSize,
      durationMs: Date.now() - startedAt,
      reused: uploadResult.reused,
      storageProvider: uploadResult.storageProvider,
      uploadMode: 'raw',
      fallbackPath: uploadResult.storageProvider === 'local-public' ? 'local-public' : 'raw',
      skippedProxy: true,
      fileKind: getSiteUploadKind(uploadResult.mimeType),
    });
    return NextResponse.json(await browserUploadResponse(user, {
      success: true,
      upload: uploadResult.upload,
      similarity: uploadResult.similarity,
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
        reused: uploadResult.reused,
        isPubliclyReachable: uploadResult.isPubliclyReachable,
        storageProvider: uploadResult.storageProvider,
        warning: uploadResult.publicUploadWarning,
        upload: uploadResult.upload,
        similarity: uploadResult.similarity,
      },
    }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (caught) {
    const error = caught instanceof UploadStreamError ? new VerifiedUploadError(caught.code, caught.message, caught.status) : caught;
    if (receiving && error instanceof VerifiedUploadError && error.status === 400
      && ['UPLOAD_BODY_MISSING', 'UPLOAD_SIZE_MISMATCH', 'UPLOAD_HASH_MISMATCH', 'UPLOAD_BODY_INTERRUPTED'].includes(error.code)) {
      try {
        const state = await transitionRawUpload(receiving.identity, receiving.nonce, 'receiving', 'notAccepted');
        if (userId) await recordAssetUploadLog({ operatorId: userId, stage: 'raw', status: 'failed', fileName, mimeType, fileSize,
          durationMs: Date.now() - startedAt, errorCode: error.code, errorMessage: error.message,
          errorStage, requestId: originalRequestId, uploadMode: 'raw', fallbackPath: 'raw', skippedProxy: true });
        return NextResponse.json({ ...verifiedUploadFailure(error), code: 'RAW_UPLOAD_NOT_ACCEPTED', causeCode: error.code,
          errorStage, notAccepted: true, rawUpload: rawUploadProof(state) }, { status: error.status });
      } catch { return NextResponse.json({ error: '原上传状态已变化，结果尚未确认', code: 'UPLOAD_RESULT_UNKNOWN', errorStage }, { status: 409 }); }
    }
    if (error instanceof VerifiedUploadError) {
      if (userId) await recordAssetUploadLog({ operatorId: userId, stage: 'raw', status: 'failed', fileName, mimeType, fileSize,
        durationMs: Date.now() - startedAt, errorCode: error.code, errorMessage: error.message,
        errorStage, requestId: originalRequestId, uploadMode: 'raw', fallbackPath: 'raw', skippedProxy: true });
      return NextResponse.json({ ...verifiedUploadFailure(error), errorStage }, { status: error.status });
    }
    console.error('[Upload] Error:', error);
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'raw',
        status: 'failed',
        fileName,
        mimeType,
        fileSize,
        durationMs: Date.now() - startedAt,
        errorCode: 'raw_failed',
        errorMessage: error instanceof Error ? error.message : 'Upload failed',
        errorStage,
        requestId: originalRequestId,
        uploadMode: 'raw',
        fallbackPath: 'raw',
        skippedProxy: true,
        fileKind: mimeType ? getSiteUploadKind(mimeType) : null,
      });
    }
    return NextResponse.json(
      { error: '上传服务暂不可用，原上传结果待确认；请核对原上传，不要重新发送文件', code: 'UPLOAD_RESULT_UNKNOWN', errorStage },
      { status: 500 }
    );
  } finally { await temporary?.cleanup().catch(() => {}); }
});
