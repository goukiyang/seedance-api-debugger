import fs from 'node:fs/promises';
import type { ApiUpload } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { rawUploadIdentity, prepareRawUpload, readRawUploadResult, readRawUploadState, transitionRawUpload,
  rawUploadRecoveryToken, recoverRetiredRawUpload } from '@/lib/assets/raw-upload-state';
import { stageVerifiedUpload, registerVerifiedUpload, releaseVerifiedUpload, uploadFileHash, uploadFileVersion,
  VerifiedUploadError, type VerifiedUpload } from '@/lib/assets/verified-upload';
import { assertNewAdmission, CustomerApiError, digest, recheckApiContext, requestId, type ApiContext } from './auth';
import { storageUsage } from './usage';
import { privateMediaPath, publishPrivateMedia } from './private-media';

function identity(context: ApiContext, upload: ApiUpload) {
  return rawUploadIdentity(context.user.id, { requestId: `api_${upload.id}`, hash: upload.sha256, fileSize: Number(upload.size_bytes), mimeType: upload.mime_type });
}
async function ownUpload(context: ApiContext, id: string) {
  const upload = await prisma.apiUpload.findFirst({ where: { id, customer_id: context.customer.id } });
  if (!upload) throw new CustomerApiError('UPLOAD_NOT_FOUND', '上传票据不存在。', 404);
  return upload;
}

export async function beginApiUpload(context: ApiContext, body: Record<string, unknown>) {
  if (Object.keys(body).some(k => !['request_id', 'sha256', 'size_bytes', 'mime_type', 'file_name'].includes(k))) throw new CustomerApiError('UNKNOWN_FIELD', '上传开始包含不支持的字段。');
  const id = requestId(body.request_id);
  const validated = rawUploadIdentity(context.user.id, { requestId: 'validation', hash: body.sha256, fileSize: body.size_bytes, mimeType: body.mime_type });
  if (typeof body.size_bytes !== 'number' || typeof body.file_name !== 'string' || !body.file_name.trim() || body.file_name.length > 240) throw new CustomerApiError('UPLOAD_INPUT', '文件名或文件大小无效。');
  const fingerprint = digest(JSON.stringify([validated.hash, validated.fileSize, validated.mimeType, body.file_name]));
  const upload = await prisma.$transaction(async tx => {
    await tx.apiConfiguration.updateMany({ where: { id: 'global' }, data: { revision: { increment: 0 } } });
    const fresh = await recheckApiContext(tx, context, 'assets:write');
    const original = await tx.apiUpload.findUnique({ where: { customer_id_request_id: { customer_id: fresh.customer.id, request_id: id } } });
    if (original) {
      if (original.fingerprint !== fingerprint) throw new CustomerApiError('UPLOAD_CONFLICT', '原上传号已用于不同文件。', 409);
      return original;
    }
    const global = await assertNewAdmission(tx, fresh), bytes = BigInt(validated.fileSize);
    if (bytes > fresh.customer.upload_limit_bytes!) throw new CustomerApiError('UPLOAD_TOO_LARGE', '文件超过客户单次上传上限。', 413);
    if (await storageUsage(tx, fresh.customer.id) + bytes > fresh.customer.storage_limit_bytes!
      || await storageUsage(tx) + bytes > global.storage_limit_bytes!) throw new CustomerApiError('STORAGE_LIMIT', '媒体存储额度不足。', 429);
    return tx.apiUpload.create({ data: { customer_id: fresh.customer.id, request_id: id, fingerprint, sha256: validated.hash,
      size_bytes: bytes, mime_type: validated.mimeType, file_name: body.file_name as string } });
  });
  if (upload.asset_id) return uploadStatus(context, upload);
  const raw = await readRawUploadState(identity(context, upload));
  if (!raw || raw.phase === 'prepared') await prepareRawUpload(identity(context, upload));
  return uploadStatus(context, upload);
}

async function bindOriginalUpload(context: ApiContext, upload: ApiUpload) {
  const original = await readRawUploadResult(identity(context, upload));
  if (!original || !upload.private_path) return null;
  const file = await privateMediaPath(upload.private_path, digest(context.user.id));
  if (!file || BigInt((await fs.stat(file)).size) !== upload.size_bytes || await uploadFileHash(file) !== upload.sha256) throw new CustomerApiError('UPLOAD_INTEGRITY', '私有原件尚未完整确认。', 409);
  const version = await uploadFileVersion(file);
  return prisma.$transaction(async tx => {
    await recheckApiContext(tx, context, 'assets:write');
    const source = await tx.asset.findUnique({ where: { id: original.id } });
    if (!source || source.owner_id !== context.user.id || source.status !== 'active' || source.hash !== upload.sha256) throw new CustomerApiError('ASSET_NOT_FOUND', '原素材已不可用。', 404);
    const existing = await tx.apiAsset.findUnique({ where: { customer_id_sha256: { customer_id: context.customer.id, sha256: upload.sha256 } } });
    if (existing && (!existing.active || existing.asset_id !== source.id || existing.private_path !== upload.private_path || existing.source_version !== version)) throw new CustomerApiError('ASSET_CHANGED', '原素材已变化，未覆盖。', 409);
    const asset = existing || await tx.apiAsset.create({ data: { customer_id: context.customer.id, asset_id: source.id, sha256: upload.sha256,
      size_bytes: upload.size_bytes, mime_type: upload.mime_type, private_path: upload.private_path!, source_version: version } });
    await tx.apiUpload.update({ where: { id: upload.id }, data: { asset_id: asset.id } });
    return asset;
  });
}

async function uploadStatus(context: ApiContext, upload: ApiUpload) {
  const asset = upload.asset_id ? await prisma.apiAsset.findFirst({ where: { id: upload.asset_id, customer_id: context.customer.id, active: true } }) : await bindOriginalUpload(context, upload);
  if (asset) {
    const source = await prisma.asset.findUnique({ where: { id: asset.asset_id } });
    if (!source || source.owner_id !== context.user.id || source.status !== 'active') throw new CustomerApiError('ASSET_NOT_FOUND', '原素材已不可用。', 404);
    return { id: upload.id, request_id: upload.request_id, status: 'completed', asset: { id: asset.id, sha256: asset.sha256,
      size_bytes: Number(asset.size_bytes), mime_type: asset.mime_type, width: source.width, height: source.height } };
  }
  const state = await readRawUploadState(identity(context, upload));
  return { id: upload.id, request_id: upload.request_id, status: state?.phase || 'prepared',
    ...(state?.phase === 'prepared' ? { transfer_nonce: state.nonce, transfer_url: `/api/v1/assets/uploads/${upload.id}/transfer` } : {}),
    recover_url: `/api/v1/assets/uploads/${upload.id}/recover`, retry_allowed: state?.phase === 'prepared' || state?.phase === 'notAccepted' };
}

async function* requestBytes(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new CustomerApiError('UPLOAD_BODY', '文件正文为空。');
  try { for (;;) { const part = await reader.read(); if (part.done) return; yield part.value; } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function transferApiUpload(context: ApiContext, id: string, request: Request) {
  const upload = await ownUpload(context, id), raw = identity(context, upload);
  if (upload.asset_id || await readRawUploadResult(raw)) return uploadStatus(context, upload);
  const nonce = request.headers.get('upload-nonce') || '';
  if (!/^[a-f0-9]{48}$/.test(nonce)) throw new CustomerApiError('UPLOAD_NONCE', '需要原上传票据的 Upload-Nonce。');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== upload.mime_type
    || request.headers.has('content-length') && request.headers.get('content-length') !== String(upload.size_bytes)) throw new CustomerApiError('UPLOAD_IDENTITY', '文件类型或大小与原票据不一致。');
  await transitionRawUpload(raw, nonce, 'prepared', 'receiving');
  let proof: VerifiedUpload | undefined, writing = false;
  try {
    proof = await stageVerifiedUpload(requestBytes(request), upload.mime_type, Number(upload.size_bytes), upload.sha256);
    await prisma.$transaction(async tx => { await recheckApiContext(tx, context, 'assets:write'); });
    await transitionRawUpload(raw, nonce, 'receiving', 'writing'); writing = true;
    const saved = await publishPrivateMedia(proof, digest(context.user.id));
    await prisma.$transaction(async tx => {
      await recheckApiContext(tx, context, 'assets:write');
      await tx.apiUpload.update({ where: { id: upload.id }, data: { private_path: saved.url } });
    });
    await registerVerifiedUpload({ ownerId: context.user.id, proof, fileName: upload.file_name, originalUrl: saved.url, thumbnailUrl: null,
      requestId: raw.requestId, fingerprint: digest(JSON.stringify([raw.hash, raw.fileSize, raw.mimeType])),
      authorize: async tx => { await recheckApiContext(tx, context, 'assets:write'); } });
    await transitionRawUpload(raw, nonce, 'writing', 'completed');
    return uploadStatus(context, { ...upload, private_path: saved.url });
  } catch (error) {
    // No registration occurs before writing. Only this proven non-write may reopen the same ticket.
    if (!writing) await transitionRawUpload(raw, nonce, 'receiving', 'notAccepted').catch(() => {});
    if (error instanceof VerifiedUploadError) throw new CustomerApiError(error.code, error.message, error.status);
    throw error;
  } finally { await releaseVerifiedUpload(proof); }
}

export async function recoverApiUpload(context: ApiContext, id: string, recover = false) {
  const upload = await ownUpload(context, id), raw = identity(context, upload);
  if (recover && !upload.asset_id && !await readRawUploadResult(raw)) {
    const state = await readRawUploadState(raw);
    if (!state) await prepareRawUpload(raw);
    else if (state.phase === 'notAccepted') await prepareRawUpload(raw, state.nonce);
    else if (['receiving', 'writing'].includes(state.phase)) {
      const proof = await rawUploadRecoveryToken(raw);
      if (proof) await recoverRetiredRawUpload(raw, proof);
    }
  }
  return uploadStatus(context, upload);
}
