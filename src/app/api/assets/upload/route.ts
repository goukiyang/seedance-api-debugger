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
import { assertUploadOwner, preflightVerifiedOwnUpload, privateUploadDirectory, uploadDigest, uploadIdentity, uploadRequestId, verifiedUploadFailure, VerifiedUploadError } from '@/lib/assets/verified-upload';
import { claimLegacyRawUpload, rawUploadIdentity, rawUploadProof, rawUploadRecoveryToken, readRawUploadResult, readRawUploadState, transitionRawUpload, type RawUploadIdentity } from '@/lib/assets/raw-upload-state';
import {
  getSiteUploadKind,
  uploadSiteAsset,
  validateSiteUploadInput,
  validateSiteUploadMetadata,
} from '@/lib/assets/site-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';
import { requestHd } from '@/lib/media/hd-derivatives';
import { uploadPreflightFailure } from '@/lib/assets/direct-upload-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const MULTIPART_COMPAT_MAX_SIZE_BYTES = 8 * 1024 * 1024;

// Read the original receipt and preparation state without changing either.
// Absence alone never proves that the original request was not accepted.
export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);
    await uploadIdentity(user.id);
    const query = request.nextUrl.searchParams;
    const identity = rawUploadIdentity(user.id, { requestId: query.get('requestId'), hash: query.get('hash'), fileSize: query.get('fileSize'), mimeType: query.get('mimeType') });
    const asset = await readRawUploadResult(identity);
    if (asset) return NextResponse.json({ success: true, asset }, { headers: { 'Cache-Control': 'private, no-store' } });
    const state = await readRawUploadState(identity);
    return NextResponse.json({ rawUpload: state ? rawUploadProof(state) : { ...identity, phase: 'absent' }, recoveryToken: await rawUploadRecoveryToken(identity) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof VerifiedUploadError) return NextResponse.json({ ...verifiedUploadFailure(error), errorStage: 'recovery' }, { status: error.status });
    return NextResponse.json({ error: '原上传结果暂时无法核对，请稍后查询；未重新发送文件' }, { status: 503 });
  }
}

type UploadPayload = {
  buffer: Buffer;
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
async function readBoundedBody(request: NextRequest, expected: number) {
  if (!request.body) throw new VerifiedUploadError('UPLOAD_BODY_MISSING', '没有收到上传文件', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > expected) throw new VerifiedUploadError('UPLOAD_SIZE_MISMATCH', '实际文件大小与声明不一致', 400);
      chunks.push(part.value);
    }
    if (size !== expected) throw new VerifiedUploadError('UPLOAD_SIZE_MISMATCH', '文件没有完整上传', 400);
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof VerifiedUploadError) throw error;
    // This request has stopped receiving bytes in memory and has not acquired
    // writing. Only its current receiving nonce may record this rejection.
    throw new VerifiedUploadError('UPLOAD_BODY_INTERRUPTED', '文件接收已中断，尚未保存；请重新选择后重试', 400);
  }
  finally { reader.releaseLock(); }
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
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return { response: NextResponse.json({ error: 'No file provided' }, { status: 400 }) };
    }

    const validationError = validateSiteUploadInput(file);
    if (validationError) return { response: NextResponse.json({ error: validationError }, { status: 400 }) };

    const buffer = Buffer.from(await file.arrayBuffer());
    return {
      payload: {
        buffer,
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
      },
    };
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

  const buffer = await readBoundedBody(request, declaredSize!);
  const actualValidationError = validateSiteUploadMetadata({
    mimeType: contentType,
    fileSize: buffer.byteLength,
  });
  if (actualValidationError) {
    return { response: NextResponse.json({ error: actualValidationError }, { status: 400 }) };
  }

  return {
    payload: {
      buffer,
      fileName,
      mimeType: contentType,
      fileSize: buffer.byteLength,
    },
  };
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let fileName: string | null = decodeFileName(request.headers.get('x-file-name'));
  let mimeType: string | null = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || null;
  let fileSize: number | null = parseContentLength(request.headers.get('x-file-size') || request.headers.get('content-length'));
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
      if (asset) return NextResponse.json({ success: true, asset });
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

    ({ fileName, mimeType, fileSize } = upload.payload);
    const { buffer } = upload.payload;
    const identity = rawUploadIdentity(user.id, { requestId: requestId || randomUUID(), hash: uploadDigest(buffer), fileSize, mimeType });
    originalRequestId = identity.requestId;
    if (receiving) {
      if (identity.hash !== receiving.identity.hash || identity.fileSize !== receiving.identity.fileSize || identity.mimeType !== receiving.identity.mimeType) {
        throw new VerifiedUploadError('UPLOAD_HASH_MISMATCH', '实际上传内容与原准备信息不一致，尚未保存', 400);
      }
    } else {
      const asset = await readRawUploadResult(identity);
      if (asset) return NextResponse.json({ success: true, asset });
      const claim = await claimLegacyRawUpload(identity);
      receiving = { identity, nonce: claim.nonce };
    }
    // Only this still-receiving nonce can prove that no persistent upload work
    // has started. Storage/staging/publishing re-check the directory afterward;
    // a later failure must remain writing/unknown, never be unlocked here.
    errorStage = 'private-directory';
    try {
      await privateUploadDirectory();
      errorStage = 'existing-asset-preflight';
      await preflightVerifiedOwnUpload(user.id, identity.hash, mimeType, fileSize);
    }
    catch (error) {
      if (errorStage !== 'existing-asset-preflight' && (!(error instanceof VerifiedUploadError)
        || !['UPLOAD_PRIVATE_DIRECTORY_INVALID', 'UPLOAD_DATA_MOUNT_REQUIRED', 'UPLOAD_CAPACITY_GUARD'].includes(error.code))) throw error;
      const failure = error instanceof VerifiedUploadError ? verifiedUploadFailure(error) : uploadPreflightFailure(error);
      const causeCode = 'causeCode' in failure && failure.causeCode || failure.code;
      let state: Awaited<ReturnType<typeof transitionRawUpload>>;
      try { state = await transitionRawUpload(identity, receiving.nonce, 'receiving', 'notAccepted'); }
      catch { throw new VerifiedUploadError('UPLOAD_RESULT_UNKNOWN', '原上传状态已变化，结果尚未确认；未重新发送文件', 409); }
      await recordAssetUploadLog({ operatorId: user.id, stage: 'raw', status: 'failed', fileName, mimeType, fileSize,
        durationMs: Date.now() - startedAt, errorCode: failure.code, causeCode, errorMessage: failure.error,
        errorStage, requestId: identity.requestId, uploadMode: 'raw', fallbackPath: 'raw', skippedProxy: true });
      return NextResponse.json({ ...failure, code: 'RAW_UPLOAD_NOT_ACCEPTED', causeCode,
        errorStage, notAccepted: true, rawUpload: rawUploadProof(state) }, { status: error instanceof VerifiedUploadError ? error.status : 503 });
    }
    errorStage = 'writing';
    await transitionRawUpload(identity, receiving.nonce, 'receiving', 'writing');
    // Once writing has been acquired, no failure may declare notAccepted.
    const writing = receiving;
    receiving = null;
    const uploadResult = await uploadSiteAsset(buffer, fileName, mimeType, fileSize, user.id, null, identity.requestId);
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
    return NextResponse.json({
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
    });
  } catch (error) {
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
  }
}
