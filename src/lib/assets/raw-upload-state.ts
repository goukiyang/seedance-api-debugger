import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { uploadDigest, uploadRequestId, readVerifiedUploadReceipt, releaseVerifiedUpload, VerifiedUploadError } from './verified-upload';
import { validateSiteUploadMetadata, sameOriginPublicUrlForLocalUpload, isLocalPublicUploadUrl } from './site-upload';
import { isPubliclyReachableUrl } from './public-storage';
import { uploadSimilarityStatus } from './upload-similarity';

export type RawUploadIdentity = { ownerId: string; requestId: string; hash: string; fileSize: number; mimeType: string };
export type RawUploadPhase = 'prepared' | 'receiving' | 'writing' | 'notAccepted' | 'completed';
export type RawUploadState = RawUploadIdentity & { version: 2; fingerprint: string; nonce: string; phase: RawUploadPhase };
export function rawUploadIdentity(ownerId: string, input: { requestId?: unknown; hash?: unknown; fileSize?: unknown; mimeType?: unknown }): RawUploadIdentity {
  const requestId = uploadRequestId(input.requestId);
  const hash = typeof input.hash === 'string' ? input.hash : '';
  const fileSize = Number(input.fileSize);
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.split(';')[0].trim().toLowerCase() : '';
  if (!requestId || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(fileSize) || fileSize <= 0
    || validateSiteUploadMetadata({ mimeType, fileSize })) throw new VerifiedUploadError('UPLOAD_IDENTITY_INVALID', '原上传文件身份无法确认', 400);
  return { ownerId, requestId, hash, fileSize, mimeType };
}
const fingerprint = (identity: RawUploadIdentity) => uploadDigest(JSON.stringify([identity.hash, identity.fileSize, identity.mimeType]));
const stateKey = (identity: RawUploadIdentity) => `raw_upload_attempt_v2:${uploadDigest(identity.ownerId)}:${uploadDigest(identity.requestId)}`;
const newNonce = () => randomBytes(24).toString('hex');
const unknown = () => new VerifiedUploadError('UPLOAD_RESULT_UNKNOWN', '原上传结果尚未确认，未重新发送文件');
function parseState(value: string, identity: RawUploadIdentity): RawUploadState {
  let state: RawUploadState;
  try { state = JSON.parse(value) as RawUploadState; } catch { throw unknown(); }
  if (!state || state.version !== 2 || state.ownerId !== identity.ownerId || state.requestId !== identity.requestId
    || state.hash !== identity.hash || state.fileSize !== identity.fileSize || state.mimeType !== identity.mimeType
    || state.fingerprint !== fingerprint(identity)) throw new VerifiedUploadError('UPLOAD_REQUEST_CONFLICT', '上传编号已用于其它文件');
  if (!/^[a-f0-9]{48}$/.test(state.nonce) || !['prepared', 'receiving', 'writing', 'notAccepted', 'completed'].includes(state.phase)) throw unknown();
  return state;
}
async function stateRow(identity: RawUploadIdentity) {
  const row = await prisma.platformSetting.findUnique({ where: { key: stateKey(identity) } });
  return row ? { row, state: parseState(row.value_json, identity) } : null;
}
export async function readRawUploadState(identity: RawUploadIdentity) {
  return (await stateRow(identity))?.state || null;
}
export async function readRawUploadResult(identity: RawUploadIdentity) {
  const found = await readVerifiedUploadReceipt(identity.ownerId, identity.requestId, fingerprint(identity));
  if (!found) return null;
  try {
    const asset = found.asset;
    const originalUrl = sameOriginPublicUrlForLocalUpload(asset.original_url) || asset.original_url;
    const thumbnailUrl = asset.thumbnail_url ? sameOriginPublicUrlForLocalUpload(asset.thumbnail_url) || asset.thumbnail_url : null;
    const similarity = await uploadSimilarityStatus(identity.ownerId, asset.id).catch(() => ({ state: 'unavailable' as const, coverage: 'new_uploads_only' as const }));
    return { id: asset.id, originalUrl, thumbnailUrl, width: asset.width, height: asset.height, fileName: asset.file_name,
      fileSize: asset.file_size, mimeType: asset.mime_type, hash: asset.hash, reused: found.reused, similarity,
      isPubliclyReachable: isPubliclyReachableUrl(originalUrl), storageProvider: isLocalPublicUploadUrl(asset.original_url) ? 'local-public' : undefined,
      ...(!isPubliclyReachableUrl(originalUrl) ? { warning: '文件已保存；当前站点未配置可供外部服务访问的原文件地址。' } : {}),
      upload: { requestId: identity.requestId, verified: true as const, assetDisposition: found.reused ? 'reused' as const : 'new' as const,
        sourceVersion: found.proof.sourceVersion || found.proof.version } };
  } finally { await releaseVerifiedUpload(found.proof); }
}
export function rawUploadProof(state: RawUploadState) {
  return { ownerId: state.ownerId, requestId: state.requestId, hash: state.hash, fileSize: state.fileSize,
    mimeType: state.mimeType, phase: state.phase, nonce: state.nonce };
}
async function replaceState(identity: RawUploadIdentity, current: NonNullable<Awaited<ReturnType<typeof stateRow>>>, next: RawUploadState) {
  const changed = await prisma.platformSetting.updateMany({ where: { key: stateKey(identity), value_json: current.row.value_json },
    data: { value_json: JSON.stringify(next), updated_by: identity.ownerId } });
  if (changed.count !== 1) throw unknown();
  return next;
}
export async function prepareRawUpload(identity: RawUploadIdentity, previousNonce?: unknown) {
  const asset = await readRawUploadResult(identity);
  if (asset) return { asset };
  const current = await stateRow(identity);
  if (previousNonce !== undefined) {
    if (typeof previousNonce !== 'string' || !current || current.state.nonce !== previousNonce
      || !['prepared', 'notAccepted'].includes(current.state.phase)) throw unknown();
    const state = await replaceState(identity, current, { ...current.state, phase: 'prepared', nonce: newNonce() });
    return { rawUpload: rawUploadProof(state) };
  }
  if (current) {
    if (current.state.phase !== 'prepared') throw unknown();
    return { rawUpload: rawUploadProof(current.state) };
  }
  const state: RawUploadState = { ...identity, version: 2, fingerprint: fingerprint(identity), nonce: newNonce(), phase: 'prepared' };
  try { await prisma.platformSetting.create({ data: { key: stateKey(identity), value_json: JSON.stringify(state), updated_by: identity.ownerId } }); }
  catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const winner = await stateRow(identity);
    if (!winner || winner.state.phase !== 'prepared') throw unknown();
    return { rawUpload: rawUploadProof(winner.state) };
  }
  return { rawUpload: rawUploadProof(state) };
}
export async function transitionRawUpload(identity: RawUploadIdentity, nonce: string, from: RawUploadPhase, to: RawUploadPhase) {
  if (!(['prepared:receiving', 'receiving:writing', 'receiving:notAccepted', 'writing:completed'] as string[]).includes(`${from}:${to}`)) throw unknown();
  const current = await stateRow(identity);
  if (!current || current.state.nonce !== nonce || current.state.phase !== from) throw unknown();
  return replaceState(identity, current, { ...current.state, phase: to });
}
// Legacy clients may acquire a brand-new identity only after their complete
// bytes have been hashed in memory. Existing attempts are never reclaimed.
export async function claimLegacyRawUpload(identity: RawUploadIdentity) {
  if (await stateRow(identity)) throw unknown();
  const state: RawUploadState = { ...identity, version: 2, fingerprint: fingerprint(identity), nonce: newNonce(), phase: 'receiving' };
  try { await prisma.platformSetting.create({ data: { key: stateKey(identity), value_json: JSON.stringify(state), updated_by: identity.ownerId } }); }
  catch (error) { if ((error as { code?: string }).code === 'P2002') throw unknown(); throw error; }
  return state;
}
