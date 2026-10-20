import { readJsonResponse } from './json-response';
import { uploadSession } from './upload-session';
import {
  calculateUploadTimeoutMs,
  notifyUploadProgress,
  requestJsonWithUploadProgress,
  type UploadProgressHandler,
  type UploadProgressSnapshot,
} from './upload-progress';

export type { UploadProgressHandler, UploadProgressSnapshot };
export type UploadRecoveryAction = 'query' | 'resume' | 'retry' | 'none';
export type UploadFileErrorOptions = {
  code?: string;
  causeCode?: string;
  stage?: string;
  recovery?: UploadRecoveryAction;
  cause?: unknown;
};
export type UploadFileFailure = {
  message: string;
  code?: string;
  causeCode?: string;
  stage?: string;
  recovery: UploadRecoveryAction;
};

export class UploadFileError extends Error {
  readonly code?: string;
  readonly causeCode?: string;
  readonly stage?: string;
  readonly recovery: UploadRecoveryAction;

  constructor(message: string, options: UploadFileErrorOptions = {}) {
    super(message);
    this.name = 'UploadFileError';
    this.code = options.code;
    this.causeCode = options.causeCode;
    this.stage = options.stage;
    this.recovery = options.recovery || 'none';
    if (options.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

export class UploadNotAcceptedError extends UploadFileError {
  constructor(message: string, options: Omit<UploadFileErrorOptions, 'recovery'> = {}) {
    super(message, { ...options, recovery: 'retry' });
    this.name = 'UploadNotAcceptedError';
  }
}

export function describeUploadFileError(error: unknown): UploadFileFailure {
  if (error instanceof UploadFileError) {
    return { message: error.message, code: error.code, causeCode: error.causeCode, stage: error.stage, recovery: error.recovery };
  }
  return { message: error instanceof Error ? error.message : '上传失败', recovery: 'none' };
}

const DEFAULT_UPLOAD_INVALID_JSON_MESSAGE = '素材上传服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';
const IMAGE_RAW_FALLBACK_MAX_SIZE_BYTES = 30 * 1024 * 1024;
const AUDIO_RAW_FALLBACK_MAX_SIZE_BYTES = 15 * 1024 * 1024;
const R2_CORS_PRODUCTION_ORIGIN = 'https://sd2.youdooart.com';
const MULTIPART_UPLOAD_MIN_SIZE_BYTES = 50 * 1024 * 1024;
const MULTIPART_UPLOAD_CONCURRENCY = 3;
const MULTIPART_RESUME_STORAGE_PREFIX = 'sd2_multipart_upload:';

export type UploadedAssetPayload = {
  id?: string;
  originalUrl?: string | null;
  thumbnailUrl?: string | null;
  width?: number | null;
  height?: number | null;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  hash?: string;
  reused?: boolean;
  isPubliclyReachable?: boolean;
  storageProvider?: string;
  warning?: string;
  upload?: { requestId: string; verified: true; assetDisposition: 'new' | 'reused'; sourceVersion: string };
  similarity?: { state: 'disabled' | 'queued' | 'running' | 'ready' | 'failed' | 'unsupported' | 'unavailable'; coverage: 'new_uploads_only'; algorithmVersion?: string };
};

export type UploadBatch = { ownerId: string; epoch: number; requests: Map<string, Promise<UploadedAssetPayload>> };
export function createUploadBatch(ownerId: string): UploadBatch { return { ownerId, epoch: uploadSession().epoch, requests: new Map() }; }
type UploadOptions = { invalidJsonMessage?: string; fallbackToRaw?: boolean; onProgress?: UploadProgressHandler;
  ownerId?: string; batch?: UploadBatch; requestId?: string; preserveUnknown?: boolean;
  beforeUpload?: (context: { hash: string; fileSize: number; mimeType: string }) => Promise<UploadedAssetPayload | null> };
const fileHashes = new WeakMap<File, Promise<string>>();
const fileRequests = new WeakMap<File, Map<string, string>>();
const inFlightUploads = new Map<string, Promise<UploadedAssetPayload>>();
const directReceipts = new WeakMap<File, { scope: string; ticket: DirectUploadTicketResponse }>();
type RawUploadIdentity = { ownerId: string; requestId: string; hash: string; fileSize: number; mimeType: string };
type RawUploadMarker = RawUploadIdentity & { version: 2; phase: 'preparing' | 'prepared' | 'sending' | 'retryable'; nonce?: string };
type LegacyRawUploadMarker = RawUploadIdentity & { version: 1 };
type RawUploadProof = RawUploadIdentity & { phase: 'absent' | 'prepared' | 'receiving' | 'writing' | 'notAccepted' | 'completed'; nonce?: string };
const rawReceipts = new WeakMap<File, { scope: string; marker: RawUploadMarker | LegacyRawUploadMarker }>();

function rawReceiptKey(file: File, context?: Partial<UploadContext>) {
  return context?.ownerId && context.hash
    ? `sd2:raw-upload:v1:${context.ownerId}:${context.hash}:${file.size}:${file.type || 'application/octet-stream'}` : null;
}

function rawIdentityMatches(value: RawUploadIdentity, expected: RawUploadIdentity) {
  return value.ownerId === expected.ownerId && value.requestId === expected.requestId && value.hash === expected.hash
    && value.fileSize === expected.fileSize && value.mimeType === expected.mimeType;
}
function saveRawMarker(file: File, context: Partial<UploadContext>, marker: RawUploadMarker) {
  const key = rawReceiptKey(file, context);
  if (!key) throw new Error('原上传身份无法安全保存，文件尚未发送。');
  try {
    const value = JSON.stringify(marker);
    sessionStorage.setItem(key, value);
    if (sessionStorage.getItem(key) !== value) throw new Error('Raw marker unavailable');
  } catch { throw new Error('原上传状态未能保存，文件尚未发送。请允许本机存储后重试。'); }
  rawReceipts.set(file, { scope: `${context.ownerId}:${uploadSession().epoch}`, marker });
}
function clearRawMarker(file: File, context: Partial<UploadContext>) {
  rawReceipts.delete(file);
  const key = rawReceiptKey(file, context);
  // Cleanup failure cannot invalidate a fully verified completed receipt.
  // A retained marker will query that same receipt on the next explicit use.
  if (key) { try { sessionStorage.removeItem(key); } catch { /* Preserve the confirmed result. */ } }
}
function readRawMarker(file: File, context: Partial<UploadContext>) {
  const scope = `${context.ownerId || 'unscoped'}:${uploadSession().epoch}`;
  const key = rawReceiptKey(file, context);
  if (!key || !context.ownerId || !context.hash) return null;
  let value: string | null;
  try { value = sessionStorage.getItem(key); }
  catch { throw new Error('原上传编号无法读取，未重新发送文件。请先核对我的素材。'); }
  if (!value) return rawReceipts.get(file)?.scope === scope ? rawReceipts.get(file)!.marker : null;
  const identity = { ownerId: context.ownerId, hash: context.hash, fileSize: file.size, mimeType: file.type || 'application/octet-stream' };
  // v0.82.2 stored only a string. Its missing server receipt never proves that
  // no bytes were sent; only the explicitly saved v2 preparing phase can do so.
  if (/^[a-zA-Z0-9_-]{1,160}$/.test(value)) return { ...identity, requestId: value, version: 1 as const };
  try {
    const marker = JSON.parse(value) as RawUploadMarker;
    if (!marker || marker.version !== 2 || !/^[a-zA-Z0-9_-]{1,160}$/.test(marker.requestId)
      || !rawIdentityMatches(marker, { ...identity, requestId: marker.requestId })
      || !['preparing', 'prepared', 'sending', 'retryable'].includes(marker.phase)
      || (marker.phase === 'preparing' ? marker.nonce !== undefined : !/^[a-f0-9]{48}$/.test(marker.nonce || ''))) throw new Error('Invalid marker');
    return marker;
  } catch { throw new Error('原上传状态无法确认，未重新发送文件。请先核对我的素材。'); }
}
function requireRawProof(value: RawUploadProof | undefined, identity: RawUploadIdentity) {
  if (!value || !rawIdentityMatches(value, identity) || !['absent', 'prepared', 'receiving', 'writing', 'notAccepted', 'completed'].includes(value.phase)
    || (value.phase === 'absent' ? value.nonce !== undefined : !/^[a-f0-9]{48}$/.test(value.nonce || ''))) {
    throw new Error('原上传状态尚未确认，未重新发送文件。');
  }
  return value;
}
function finishRawAsset(file: File, context: Partial<UploadContext>, identity: RawUploadIdentity, asset: UploadedAssetPayload, onProgress?: UploadProgressHandler) {
  if (!asset.id || asset.hash !== identity.hash || asset.fileSize !== identity.fileSize || asset.mimeType !== identity.mimeType
    || asset.upload?.verified !== true || asset.upload.requestId !== identity.requestId) {
    throw new UploadFileError('原上传结果身份无法确认，原上传记录已保留；请核对原上传。', {
      code: 'RAW_UPLOAD_RESULT_UNKNOWN', stage: 'raw-verify', recovery: 'query',
    });
  }
  clearRawMarker(file, context);
  notifyUploadProgress(onProgress, { phase: 'done', label: asset.reused ? '已复用相同素材' : '上传完成', loadedBytes: file.size, totalBytes: file.size });
  return asset;
}
async function recoverRawUpload(file: File, context: Partial<UploadContext>, invalidJsonMessage: string, onProgress?: UploadProgressHandler) {
  const marker = readRawMarker(file, context);
  if (!marker) return null;
  notifyUploadProgress(onProgress, { phase: 'complete', label: '正在核对原上传结果' });
  const query = new URLSearchParams({ requestId: marker.requestId, hash: marker.hash, fileSize: String(marker.fileSize), mimeType: marker.mimeType });
  let response: Response;
  try { response = await fetch(`/api/assets/upload?${query}`, { headers: { 'X-Upload-Owner-Id': marker.ownerId }, cache: 'no-store', signal: AbortSignal.timeout(calculateUploadTimeoutMs(file.size)) }); }
  catch (cause) { throw new UploadFileError('原上传结果待确认；再次点击上传只查询原结果，不会重传文件。', { stage: 'raw-query', recovery: 'query', cause }); }
  let result: UploadAssetResponse;
  try { result = await readUploadJsonResponse<UploadAssetResponse>(response, '原上传查询', invalidJsonMessage); }
  catch (cause) { throw new UploadFileError(cause instanceof Error ? cause.message : '原上传查询返回内容无效。', { stage: 'raw-query', recovery: 'query', cause }); }
  if (!response.ok) throw responseUploadError(result, '原上传结果尚未确认，未重传文件。', 'query', 'raw-query');
  if (result.asset?.id) return finishRawAsset(file, context, marker, result.asset, onProgress);
  if (typeof result.recoveryToken === 'string' && /^[a-f0-9]{64}$/.test(result.recoveryToken)) {
    let recovered: UploadAssetResponse;
    try {
      const response = await fetch('/api/assets/upload/recover', { method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Upload-Owner-Id': marker.ownerId },
        body: JSON.stringify({ ...marker, recoveryToken: result.recoveryToken }), signal: AbortSignal.timeout(30000) });
      recovered = await readUploadJsonResponse<UploadAssetResponse>(response, '恢复原上传', invalidJsonMessage);
      if (!response.ok) throw responseUploadError(recovered, '原上传尚不能安全恢复，未重传文件。', 'query', 'raw-recover');
    } catch (cause) { throw new UploadFileError('原上传恢复结果待确认，请再次核对原上传；未重新发送文件。', { stage: 'raw-recover', recovery: 'query', cause }); }
    if (recovered.asset?.id) return finishRawAsset(file, context, marker, recovered.asset, onProgress);
    const proof = requireRawProof(recovered.rawUpload, marker);
    if (proof.phase !== 'notAccepted') throw new UploadFileError('原上传尚不能安全恢复，未重传文件。', { stage: 'raw-recover', recovery: 'query' });
    saveRawMarker(file, context, { ...marker, version: 2, phase: 'retryable', nonce: proof.nonce });
    throw new UploadNotAcceptedError('原上传已安全结束，未登记素材。点击继续上传会沿用原请求和原文件。', { code: 'RAW_UPLOAD_NOT_ACCEPTED', stage: 'raw-recover' });
  }
  let proof: RawUploadProof;
  try { proof = requireRawProof(result.rawUpload, marker); }
  catch (cause) { throw new UploadFileError(cause instanceof Error ? cause.message : '原上传状态尚未确认，未重新发送文件。', { stage: 'raw-query', recovery: 'query', cause }); }
  if (proof.phase === 'absent' && marker.version === 2 && marker.phase === 'preparing') {
    return performRawUpload(file, context, marker, invalidJsonMessage, onProgress);
  }
  if (proof.phase === 'prepared' && marker.version === 2 && ['preparing', 'prepared'].includes(marker.phase)) {
    const prepared: RawUploadMarker = { ...marker, phase: 'prepared', nonce: proof.nonce };
    saveRawMarker(file, context, prepared);
    return performRawUpload(file, context, prepared, invalidJsonMessage, onProgress);
  }
  if (['prepared', 'notAccepted'].includes(proof.phase)) {
    if (marker.version === 2 && marker.phase === 'retryable' && marker.nonce === proof.nonce) {
      return performRawUpload(file, context, marker, invalidJsonMessage, onProgress);
    }
    saveRawMarker(file, context, { ownerId: marker.ownerId, requestId: marker.requestId, hash: marker.hash,
      fileSize: marker.fileSize, mimeType: marker.mimeType, version: 2, phase: 'retryable', nonce: proof.nonce });
    throw new UploadNotAcceptedError('原上传确认尚未写入文件。请再次主动点击上传，系统会先核对并更新原准备信息。', {
      code: 'RAW_UPLOAD_NOT_ACCEPTED', stage: 'raw-query',
    });
  }
  throw new UploadFileError('原上传仍在处理或结果未知，未重新发送文件。请稍后查询。', {
    code: 'RAW_UPLOAD_RESULT_UNKNOWN', stage: `raw-${proof.phase}`, recovery: 'query',
  });
}

/** Collapse reference selection, not generation items, by full client bytes. Server verification remains authoritative. */
export async function uniqueUploadFiles(files: File[]) {
  const seen = new Set<string>(), unique: File[] = [];
  for (const file of files) {
    const key = `${await sha256File(file)}:${file.size}:${file.type}`;
    if (!seen.has(key)) { seen.add(key); unique.push(file); }
  }
  return { files: unique, duplicates: files.length - unique.length };
}

type UploadAssetResponse = {
  success?: boolean;
  asset?: UploadedAssetPayload;
  error?: string;
  message?: string;
  code?: string;
  causeCode?: string;
  errorStage?: string;
  notAccepted?: boolean;
  rawUpload?: RawUploadProof;
  recoveryToken?: string | null;
};

function safeUploadDiagnostic(value: unknown) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
}

function responseUploadError(
  response: Pick<UploadAssetResponse, 'message' | 'error' | 'code' | 'causeCode' | 'errorStage'>,
  fallback: string,
  recovery: UploadRecoveryAction,
  stage: string,
) {
  return new UploadFileError(response.message || response.error || fallback, {
    code: safeUploadDiagnostic(response.code),
    causeCode: safeUploadDiagnostic(response.causeCode),
    stage: safeUploadDiagnostic(response.errorStage) || stage,
    recovery,
  });
}

type DirectUploadTicketResponse = {
  directUploadAvailable?: boolean;
  reused?: boolean;
  asset?: UploadedAssetPayload;
  storageProvider?: string;
  uploadUrl?: string;
  uploadToken?: string;
  publicUrl?: string;
  method?: 'PUT' | 'POST';
  headers?: Record<string, string>;
  expiresAt?: string;
  reason?: string;
  error?: string;
  message?: string;
};

type MultipartUploadStartResponse = {
  directUploadAvailable?: boolean;
  uploadMode?: 'multipart';
  reused?: boolean;
  asset?: UploadedAssetPayload;
  storageProvider?: string;
  uploadToken?: string;
  uploadId?: string;
  partSize?: number;
  partCount?: number;
  expiresAt?: string;
  reason?: string;
  error?: string;
  message?: string;
};

type MultipartUploadPartResponse = {
  uploadUrl?: string;
  method?: 'PUT';
  headers?: Record<string, string>;
  partNumber?: number;
  expiresAt?: string;
  error?: string;
  message?: string;
};

type UploadContext = {
  hash: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  ownerId?: string;
  requestId?: string;
};

type MultipartUploadedPart = {
  partNumber: number;
  eTag: string;
};

type MultipartResumeState = {
  hash: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadToken: string;
  uploadId: string;
  partSize: number;
  expiresAt: string;
  parts: MultipartUploadedPart[];
  phase?: 'uploading' | 'completing';
};

export function buildRawFileUploadRequest(file: File, context?: Partial<UploadContext>): RequestInit {
  const headers: Record<string, string> = {
    'Content-Type': file.type || 'application/octet-stream',
    'X-File-Name': encodeURIComponent(file.name || 'upload.bin'),
    'X-File-Size': String(file.size),
  };
  if (context?.width != null) headers['X-Media-Width'] = String(context.width);
  if (context?.height != null) headers['X-Media-Height'] = String(context.height);
  if (context?.durationSeconds != null) headers['X-Media-Duration'] = String(context.durationSeconds);
  if (context?.requestId) headers['X-Upload-Request-Id'] = context.requestId;
  if (context?.ownerId) headers['X-Upload-Owner-Id'] = context.ownerId;
  return {
    method: 'POST',
    headers,
    body: file,
  };
}

function uploadStageInvalidJsonMessage(stage: string, fallbackMessage: string) {
  const retryHint = fallbackMessage.includes('重新登录')
    ? '请刷新后重试；如果仍出现，请重新登录。'
    : '请重新上传后重试。';
  return `${stage}返回了页面内容，系统没有拿到有效上传结果。${retryHint}`;
}

function uploadStageConnectionMessage(stage: string, error: unknown) {
  const message = error instanceof Error ? error.message.trim() : '';
  if (message.includes('返回了页面内容')) return message;
  const detail = message && message !== 'Failed to fetch' ? `（${message}）` : '';
  return `${stage}连接中断，系统没有拿到有效上传结果${detail}。这通常是网络或上传中转链路中断，不等于文件过大；请重新上传，连续出现时请联系管理员检查上传链路。`;
}

function uploadStageTimeoutMessage(stage: string) {
  return `${stage}时间过长，系统还没有收到完整文件。请检查网络后重新上传；连续出现时请联系管理员检查上传链路。`;
}

async function readUploadJsonResponse<T>(
  response: Response,
  stage: string,
  invalidJsonMessage: string,
) {
  return readJsonResponse<T>(response, {
    invalidJsonMessage: uploadStageInvalidJsonMessage(stage, invalidJsonMessage),
    includeDiagnostics: true,
  });
}

async function uploadWithRawFallback(
  file: File,
  invalidJsonMessage: string,
  onProgress?: UploadProgressHandler,
  context?: Partial<UploadContext>,
) {
  if (!context?.ownerId || !context.requestId || !/^[a-f0-9]{64}$/.test(context.hash || '')) {
    throw new Error('当前无法安全核验账号和文件，未上传。请重新登录后再选择文件。');
  }
  const recovered = context ? await recoverRawUpload(file, context, invalidJsonMessage, onProgress) : null;
  if (recovered) return recovered;
  const marker: RawUploadMarker = { version: 2, ownerId: context.ownerId, requestId: context.requestId, hash: context.hash!,
    fileSize: file.size, mimeType: file.type || 'application/octet-stream', phase: 'preparing' };
  saveRawMarker(file, context, marker);
  return performRawUpload(file, context, marker, invalidJsonMessage, onProgress);
}

async function performRawUpload(file: File, context: Partial<UploadContext>, original: RawUploadMarker, invalidJsonMessage: string, onProgress?: UploadProgressHandler) {
  let marker = original;
  if (marker.phase === 'preparing' || marker.phase === 'retryable') {
    notifyUploadProgress(onProgress, { phase: 'ticket', label: '正在准备普通上传' });
    let response: Response;
    try {
      response = await fetch('/api/assets/upload-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Owner-Id': marker.ownerId },
        body: JSON.stringify({ mode: 'raw', ownerId: marker.ownerId, requestId: marker.requestId, hash: marker.hash,
          fileSize: marker.fileSize, mimeType: marker.mimeType, ...(marker.phase === 'retryable' ? { previousNonce: marker.nonce } : {}) }),
        signal: AbortSignal.timeout(30000) });
    } catch (cause) { throw new UploadFileError('普通上传准备结果待确认，尚未发送文件。请再次点击核对原准备信息。', { stage: 'raw-prepare', recovery: 'query', cause }); }
    let result: UploadAssetResponse;
    try { result = await readUploadJsonResponse<UploadAssetResponse>(response, '普通上传准备', invalidJsonMessage); }
    catch (cause) { throw new UploadFileError(cause instanceof Error ? cause.message : '普通上传准备返回内容无效。', { stage: 'raw-prepare', recovery: 'query', cause }); }
    if (!response.ok) throw responseUploadError(result, '普通上传准备未完成，尚未发送文件。', 'query', 'raw-prepare');
    if (result.asset?.id) return finishRawAsset(file, context, marker, result.asset, onProgress);
    let proof: RawUploadProof;
    try { proof = requireRawProof(result.rawUpload, marker); }
    catch (cause) { throw new UploadFileError(cause instanceof Error ? cause.message : '原上传执行权尚未确认，未发送文件。', { stage: 'raw-prepare', recovery: 'query', cause }); }
    if (proof.phase !== 'prepared' || marker.phase === 'retryable' && proof.nonce === marker.nonce) {
      throw new UploadFileError('原上传执行权尚未确认，原上传记录已保留；请核对原上传。', {
        code: 'RAW_UPLOAD_RESULT_UNKNOWN', stage: 'raw-prepare', recovery: 'query',
      });
    }
    marker = { ...marker, phase: 'prepared', nonce: proof.nonce };
    saveRawMarker(file, context, marker);
  }
  if (marker.phase !== 'prepared' || !/^[a-f0-9]{48}$/.test(marker.nonce || '')) {
    throw new UploadFileError('原上传尚未准备完成，原上传记录已保留；请核对原上传。', {
      code: 'RAW_UPLOAD_RESULT_UNKNOWN', stage: 'raw-prepare', recovery: 'query',
    });
  }
  // Persist sending before the request can emit bytes. A crash at this point
  // must recover by server state and nonce rotation, never by marker absence.
  marker = { ...marker, phase: 'sending' };
  saveRawMarker(file, context, marker);
  const request = buildRawFileUploadRequest(file, { ...context, ownerId: marker.ownerId, requestId: marker.requestId, hash: marker.hash });
  const headers = { ...request.headers as Record<string, string>, 'X-File-Hash': marker.hash, 'X-Raw-Upload-Version': '2', 'X-Raw-Upload-Nonce': marker.nonce! };
  let result: { ok: boolean; status: number; data: UploadAssetResponse };
  try {
    result = await requestJsonWithUploadProgress<UploadAssetResponse>({
      url: '/api/assets/upload',
      method: 'POST',
      headers,
      body: file,
      invalidJsonMessage: uploadStageInvalidJsonMessage('普通上传接口', invalidJsonMessage),
      connectionMessage: uploadStageConnectionMessage('普通上传', new Error('网络中断')),
      timeoutMessage: uploadStageTimeoutMessage('普通上传'),
      progress: {
        phase: 'raw',
        label: '正在普通上传',
        totalBytes: file.size,
      },
      onProgress,
    });
  } catch (cause) { throw new UploadFileError('普通上传结果待确认；再次点击上传只核对原结果，不会立即重传文件。', { stage: 'raw-upload', recovery: 'query', cause }); }
  const data = result.data;
  if (!result.ok) {
    if (data.notAccepted === true && data.code === 'RAW_UPLOAD_NOT_ACCEPTED') {
      let proof: RawUploadProof;
      try { proof = requireRawProof(data.rawUpload, marker); }
      catch (cause) { throw new UploadFileError(cause instanceof Error ? cause.message : '原上传结果尚未确认，未重传文件。', { stage: 'raw-upload', recovery: 'query', cause }); }
      if (proof.phase !== 'notAccepted' || proof.nonce !== marker.nonce) {
        throw new UploadFileError('原上传结果尚未确认，未重传文件。', { stage: 'raw-upload', recovery: 'query' });
      }
      saveRawMarker(file, context, { ...marker, phase: 'retryable' });
      throw new UploadNotAcceptedError(data.message || data.error || '服务器确认原文件未被接收，可以安全重试上传。', {
        code: 'RAW_UPLOAD_NOT_ACCEPTED', causeCode: safeUploadDiagnostic(data.causeCode),
        stage: safeUploadDiagnostic(data.errorStage) || 'raw-upload',
      });
    }
    throw responseUploadError(data, '原上传结果尚未确认，请核对原上传。', 'query', 'raw-upload');
  }
  if (!data.asset?.id) throw new UploadFileError('普通上传结果尚未确认，请查询原上传。', { stage: 'raw-upload', recovery: 'query' });
  return finishRawAsset(file, context, marker, data.asset, onProgress);
}

function canUseRawFallback(file: File) {
  if (file.type.startsWith('image/')) return file.size <= IMAGE_RAW_FALLBACK_MAX_SIZE_BYTES;
  if (file.type.startsWith('audio/')) return file.size <= AUDIO_RAW_FALLBACK_MAX_SIZE_BYTES;
  return false;
}

function shouldUseRawFallback(file: File, fallbackToRaw: boolean) {
  return fallbackToRaw && canUseRawFallback(file);
}

function rawFallbackUnavailableMessage(reason: string, file?: File) {
  if (file?.type.startsWith('video/')) {
    return `${reason.replace(/[。；;,.，]+$/, '')}。当前视频不能自动改用普通上传；请联系管理员确认 R2 CORS 已允许 ${R2_CORS_PRODUCTION_ORIGIN} 使用 PUT、Content-Type 和 ETag，或启用视频分块上传验收路径。`;
  }
  return `${reason.replace(/[。；;,.，]+$/, '')}。当前文件不能自动改用普通上传（仅支持 30MB 以内图片或 15MB 以内音频自动回退），请刷新页面或重新登录后重试；如果仍出现，请联系管理员确认 R2 CORS 已允许 ${R2_CORS_PRODUCTION_ORIGIN} 使用 PUT 和 Content-Type。`;
}

async function uploadWithRawFallbackOrThrow(
  file: File,
  invalidJsonMessage: string,
  fallbackToRaw: boolean,
  reason: string,
  onProgress?: UploadProgressHandler,
  context?: Partial<UploadContext>,
) {
  if (shouldUseRawFallback(file, fallbackToRaw)) {
    return uploadWithRawFallback(file, invalidJsonMessage, onProgress, context);
  }
  throw new Error(rawFallbackUnavailableMessage(reason, file));
}

async function uploadWithServerProxy(
  ticket: DirectUploadTicketResponse,
  file: File,
  context: UploadContext,
  invalidJsonMessage: string,
  onProgress?: UploadProgressHandler,
) {
  if (!ticket.uploadToken) throw new Error('缺少上传票据，请重新上传。');
  const headers: Record<string, string> = {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Upload-Token': ticket.uploadToken,
    'X-File-Hash': context.hash,
  };
  if (context.width != null) {
    headers['X-Media-Width'] = String(context.width);
    headers['X-Image-Width'] = String(context.width);
  }
  if (context.height != null) {
    headers['X-Media-Height'] = String(context.height);
    headers['X-Image-Height'] = String(context.height);
  }
  if (context.durationSeconds != null) headers['X-Media-Duration'] = String(context.durationSeconds);

  let result: { ok: boolean; status: number; data: UploadAssetResponse };
  try {
    result = await requestJsonWithUploadProgress<UploadAssetResponse>({
      url: '/api/assets/upload-proxy',
      method: 'POST',
      headers,
      body: file,
      invalidJsonMessage: uploadStageInvalidJsonMessage('服务端中转上传接口', invalidJsonMessage),
      connectionMessage: uploadStageConnectionMessage('服务端中转上传', new Error('网络中断')),
      timeoutMessage: uploadStageTimeoutMessage('服务端中转上传'),
      progress: {
        phase: 'proxy',
        label: '正在服务端中转上传',
        totalBytes: file.size,
      },
      onProgress,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('系统没有拿到有效上传结果')) throw error;
    throw new Error(uploadStageConnectionMessage('服务端中转上传', error));
  }
  const data = result.data;
  if (!result.ok) throw new Error(data.error || data.message || '服务端中转上传失败，请重新选择后重试');
  if (!data.asset?.id) throw new Error('服务端中转上传成功，但没有返回素材 ID');
  notifyUploadProgress(onProgress, {
    phase: 'done',
    label: data.asset.reused ? '已复用相同素材' : '上传完成',
    loadedBytes: file.size,
    totalBytes: file.size,
  });
  return data.asset;
}

function shouldUseMultipartUpload(file: File) {
  return file.type.startsWith('video/') && file.size > MULTIPART_UPLOAD_MIN_SIZE_BYTES;
}

function multipartResumeKey(file: File, hash: string, ownerId?: string) {
  return `${MULTIPART_RESUME_STORAGE_PREFIX}v2:${ownerId}:${hash}:${file.size}:${file.type || 'application/octet-stream'}`;
}

function readMultipartResumeState(file: File, hash: string, ownerId?: string): MultipartResumeState | null {
  if (typeof window === 'undefined' || !ownerId) return null;
  const raw = sessionStorage.getItem(multipartResumeKey(file, hash, ownerId));
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as MultipartResumeState;
    if (
      state.hash !== hash ||
      state.fileSize !== file.size ||
      state.mimeType !== (file.type || 'application/octet-stream') ||
      !state.uploadToken ||
      !state.uploadId ||
      !Number.isFinite(state.partSize) ||
      state.partSize <= 0 ||
      new Date(state.expiresAt).getTime() <= Date.now() && state.phase !== 'completing'
    ) {
      sessionStorage.removeItem(multipartResumeKey(file, hash, ownerId));
      return null;
    }
    return {
      ...state,
      parts: Array.isArray(state.parts) ? state.parts.filter((part) => part.partNumber > 0 && part.eTag) : [],
    };
  } catch {
    sessionStorage.removeItem(multipartResumeKey(file, hash, ownerId));
    return null;
  }
}

function writeMultipartResumeState(file: File, state: MultipartResumeState, ownerId?: string) {
  if (typeof window === 'undefined' || !ownerId) return;
  sessionStorage.setItem(multipartResumeKey(file, state.hash, ownerId), JSON.stringify(state));
}

function clearMultipartResumeState(file: File, hash: string, ownerId?: string) {
  if (typeof window === 'undefined' || !ownerId) return;
  sessionStorage.removeItem(multipartResumeKey(file, hash, ownerId));
}

function durableMultipartResumeState(
  file: File,
  context: UploadContext,
  expected: MultipartResumeState,
  phase?: MultipartResumeState['phase'],
) {
  try {
    const saved = readMultipartResumeState(file, context.hash, context.ownerId);
    return saved && saved.uploadToken === expected.uploadToken && saved.uploadId === expected.uploadId
      && saved.hash === expected.hash && saved.fileSize === expected.fileSize && saved.mimeType === expected.mimeType
      && (!phase || saved.phase === phase) ? saved : null;
  } catch {
    return null;
  }
}

function hasDurableMultipartResumeState(file: File, context: UploadContext, expected: MultipartResumeState) {
  return !!durableMultipartResumeState(file, context, expected);
}

function hasCompleteMultipartParts(file: File, state: MultipartResumeState) {
  const partCount = Math.ceil(file.size / state.partSize);
  const parts = new Map<number, string>();
  for (const part of state.parts) parts.set(part.partNumber, part.eTag);
  return parts.size === partCount && Array.from({ length: partCount }, (_, index) => index + 1).every(partNumber => {
    const eTag = parts.get(partNumber);
    const normalized = typeof eTag === 'string' ? normalizePartEtag(eTag) : '';
    return normalized.length > 0 && normalized.length <= 256;
  });
}

function normalizePartEtag(value: string | null) {
  return (value || '').trim();
}

function putFilePartToStorage(
  url: string,
  headers: Record<string, string>,
  blob: Blob,
  fileSize: number,
  loadedOffset: () => number,
  onProgress?: UploadProgressHandler,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    notifyUploadProgress(onProgress, {
      phase: 'multipart',
      label: '正在分块上传',
      loadedBytes: loadedOffset(),
      totalBytes: fileSize,
    });
    xhr.upload.onprogress = (event) => {
      const partLoaded = event.lengthComputable ? event.loaded : 0;
      notifyUploadProgress(onProgress, {
        phase: 'multipart',
        label: '正在分块上传',
        loadedBytes: loadedOffset() + partLoaded,
        totalBytes: fileSize,
      });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const eTag = normalizePartEtag(xhr.getResponseHeader('ETag'));
        if (!eTag) {
          reject(new Error('分块上传成功但没有返回 ETag，请确认 R2 CORS 暴露 ETag 后重试。'));
          return;
        }
        resolve(eTag);
      } else {
        reject(new Error(`分块上传失败（HTTP ${xhr.status || '未知'}）`));
      }
    };
    xhr.onerror = () => reject(new Error('分块上传连接中断，请检查网络后重试。'));
    xhr.ontimeout = () => reject(new Error(uploadStageTimeoutMessage('分块上传')));
    xhr.timeout = calculateUploadTimeoutMs(blob.size);
    xhr.send(blob);
  });
}

async function requestMultipartPartTicket(
  uploadToken: string,
  partNumber: number,
  invalidJsonMessage: string,
) {
  let response: Response;
  try {
    response = await fetch('/api/assets/multipart/sign-part', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadToken, partNumber }),
    });
  } catch (error) {
    throw new Error(uploadStageConnectionMessage('分块上传签名', error));
  }
  const data = await readUploadJsonResponse<MultipartUploadPartResponse>(
    response,
    '分块上传签名接口',
    invalidJsonMessage,
  );
  if (!response.ok) throw new Error(data.error || data.message || '分块上传签名失败');
  if (!data.uploadUrl || data.method !== 'PUT') {
    throw new Error('分块上传签名内容不完整，请重新上传。');
  }
  return data;
}

function shouldKeepMultipartResumeState(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return (
    message.includes('连接中断') ||
    message.includes('时间过长') ||
    message.includes('网络') ||
    message.includes('Failed to fetch')
  );
}

async function abortMultipartUpload(uploadToken: string, invalidJsonMessage: string) {
  let response: Response;
  try {
    response = await fetch('/api/assets/multipart/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadToken }),
    });
  } catch {
    return;
  }
  if (!response.ok) {
    await readUploadJsonResponse(response, '分块上传清理接口', invalidJsonMessage).catch(() => null);
  }
}

async function uploadWithMultipart(
  file: File,
  context: UploadContext,
  invalidJsonMessage: string,
  onProgress?: UploadProgressHandler,
  preserveUnknown = true,
): Promise<UploadedAssetPayload | null> {
  if (!shouldUseMultipartUpload(file)) return null;

  let state = readMultipartResumeState(file, context.hash, context.ownerId);
  if (!state) {
    notifyUploadProgress(onProgress, {
      phase: 'multipart_start',
      label: '正在创建分块上传',
    });
    let startRes: Response;
    try {
      startRes = await fetch('/api/assets/multipart/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name || 'upload.bin',
          mimeType: file.type || 'application/octet-stream',
          fileSize: file.size,
          hash: context.hash,
          width: context.width,
          height: context.height,
          durationSeconds: context.durationSeconds,
          requestId: context.requestId,
          ownerId: context.ownerId,
        }),
      });
    } catch (error) {
      throw new Error(uploadStageConnectionMessage('分块上传初始化', error));
    }
    const start = await readUploadJsonResponse<MultipartUploadStartResponse>(
      startRes,
      '分块上传初始化接口',
      invalidJsonMessage,
    );
    if (!startRes.ok) throw preserveUnknown && startRes.status >= 400 && startRes.status < 500
      ? new UploadNotAcceptedError(start.error || start.message || '分块上传初始化被拒绝，原文件未发送')
      : new Error(start.error || start.message || '分块上传初始化失败');
    if (start.reused === true && start.asset?.id) {
      notifyUploadProgress(onProgress, {
        phase: 'done',
        label: '已复用相同素材',
        loadedBytes: file.size,
        totalBytes: file.size,
      });
      return start.asset;
    }
    if (start.directUploadAvailable === false) return null;
    if (!start.uploadToken || !start.uploadId || !start.partSize || !start.expiresAt) {
      throw new Error('分块上传票据内容不完整，请重新上传。');
    }
    state = {
      hash: context.hash,
      fileName: file.name || 'upload.bin',
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      uploadToken: start.uploadToken,
      uploadId: start.uploadId,
      partSize: start.partSize,
      expiresAt: start.expiresAt,
      parts: [],
    };
    writeMultipartResumeState(file, state, context.ownerId);
  }

  const completedParts = new Map<number, string>();
  for (const part of state.parts) completedParts.set(part.partNumber, part.eTag);
  const partCount = Math.ceil(file.size / state.partSize);
  const hasEveryPart = () => completedParts.size === partCount
    && Array.from({ length: partCount }, (_, index) => index + 1).every(partNumber => {
      const eTag = completedParts.get(partNumber);
      const normalized = typeof eTag === 'string' ? normalizePartEtag(eTag) : '';
      return normalized.length > 0 && normalized.length <= 256;
    });
  if (state.phase === 'completing' && !hasEveryPart()) {
    throw new UploadFileError('原分块上传登记待确认，但本机状态不完整；已保留原记录，请在原素材结果中核对。', {
      code: 'MULTIPART_UPLOAD_STATE_INCOMPLETE', stage: 'multipart-complete', recovery: 'none',
    });
  }
  const loadedPartBytes = () => {
    let loaded = 0;
    for (const partNumber of Array.from(completedParts.keys())) {
      const start = (partNumber - 1) * state!.partSize;
      loaded += Math.max(0, Math.min(state!.partSize, file.size - start));
    }
    return loaded;
  };
  let cursor = 1;

  const uploadNextPart = async () => {
    while (cursor <= partCount) {
      const partNumber = cursor;
      cursor += 1;
      if (completedParts.has(partNumber)) continue;
      const start = (partNumber - 1) * state!.partSize;
      const end = Math.min(file.size, start + state!.partSize);
      const part = file.slice(start, end, file.type || 'application/octet-stream');
      const partTicket = await requestMultipartPartTicket(state!.uploadToken, partNumber, invalidJsonMessage);
      const eTag = await putFilePartToStorage(
        partTicket.uploadUrl!,
        partTicket.headers || {},
        part,
        file.size,
        loadedPartBytes,
        onProgress,
      );
      completedParts.set(partNumber, eTag);
      state!.parts = Array.from(completedParts.entries())
        .map(([currentPartNumber, currentETag]) => ({ partNumber: currentPartNumber, eTag: currentETag }))
        .sort((a, b) => a.partNumber - b.partNumber);
      writeMultipartResumeState(file, state!, context.ownerId);
    }
  };

  if (state.phase !== 'completing') {
    try {
      await Promise.all(Array.from({ length: Math.min(MULTIPART_UPLOAD_CONCURRENCY, partCount) }, uploadNextPart));
    } catch (error) {
      if (preserveUnknown && hasDurableMultipartResumeState(file, context, state)) {
        throw new UploadFileError(error instanceof Error ? error.message : '原分块上传尚未完成。', {
          code: 'MULTIPART_UPLOAD_RESUMABLE', stage: 'multipart-upload', recovery: 'resume', cause: error,
        });
      }
      if (state && !preserveUnknown && !shouldKeepMultipartResumeState(error)) {
        await abortMultipartUpload(state.uploadToken, invalidJsonMessage);
        clearMultipartResumeState(file, context.hash, context.ownerId);
      }
      throw error;
    }
  }

  notifyUploadProgress(onProgress, {
    phase: 'multipart_complete',
    label: '正在合并上传结果',
    loadedBytes: file.size,
    totalBytes: file.size,
  });
  state.phase = 'completing';
  writeMultipartResumeState(file, state, context.ownerId);
  const savedCompletion = durableMultipartResumeState(file, context, state, 'completing');
  const completionIsDurable = !!savedCompletion && hasCompleteMultipartParts(file, savedCompletion);

  let completeRes: Response;
  try {
    completeRes = await fetch('/api/assets/multipart/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(context.ownerId ? { 'X-Upload-Owner-Id': context.ownerId } : {}) },
      body: JSON.stringify({
        ownerId: context.ownerId,
        uploadToken: state.uploadToken,
        hash: context.hash,
        width: context.width,
        height: context.height,
        durationSeconds: context.durationSeconds,
        parts: state.parts,
      }),
    });
  } catch (error) {
    const message = uploadStageConnectionMessage('分块上传完成登记', error);
    if (preserveUnknown && completionIsDurable) throw new UploadFileError(message, {
      code: 'MULTIPART_UPLOAD_RESULT_UNKNOWN', stage: 'multipart-complete', recovery: 'query', cause: error,
    });
    throw new Error(message);
  }
  let complete: UploadAssetResponse;
  try {
    complete = await readUploadJsonResponse<UploadAssetResponse>(
      completeRes,
      '分块上传完成登记接口',
      invalidJsonMessage,
    );
  } catch (error) {
    if (preserveUnknown && completionIsDurable) throw new UploadFileError(
      error instanceof Error ? error.message : '分块上传完成登记返回内容无效。',
      { code: 'MULTIPART_UPLOAD_RESULT_UNKNOWN', stage: 'multipart-complete', recovery: 'query', cause: error },
    );
    throw error;
  }
  if (!completeRes.ok) {
    if (preserveUnknown) {
      if (completionIsDurable) throw new UploadFileError(
        complete.message || complete.error || '分块上传结果待确认，请核对原上传。',
        {
          code: safeUploadDiagnostic(complete.code) || 'MULTIPART_UPLOAD_RESULT_UNKNOWN',
          causeCode: safeUploadDiagnostic(complete.causeCode),
          stage: safeUploadDiagnostic(complete.errorStage) || 'multipart-complete',
          recovery: 'query',
        },
      );
      throw new Error(complete.error || complete.message || '分块上传结果待确认，请核对原上传。');
    }
    await abortMultipartUpload(state.uploadToken, invalidJsonMessage);
    clearMultipartResumeState(file, context.hash, context.ownerId);
    throw new Error(complete.error || complete.message || '分块上传完成登记失败');
  }
  if (!complete.asset?.id) {
    if (preserveUnknown) {
      if (completionIsDurable) throw new UploadFileError('分块上传结果未知，请核对原上传。', {
        code: safeUploadDiagnostic(complete.code) || 'MULTIPART_UPLOAD_RESULT_UNKNOWN',
        causeCode: safeUploadDiagnostic(complete.causeCode),
        stage: safeUploadDiagnostic(complete.errorStage) || 'multipart-complete',
        recovery: 'query',
      });
      throw new Error('分块上传结果未知，请核对原上传。');
    }
    await abortMultipartUpload(state.uploadToken, invalidJsonMessage);
    clearMultipartResumeState(file, context.hash, context.ownerId);
    throw new Error('分块上传完成但没有返回素材 ID');
  }
  clearMultipartResumeState(file, context.hash, context.ownerId);
  notifyUploadProgress(onProgress, {
    phase: 'done',
    label: '上传完成',
    loadedBytes: file.size,
    totalBytes: file.size,
  });
  return complete.asset;
}

async function sha256File(file: File) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器无法安全核验文件，未上传。请刷新或使用支持文件校验的浏览器。');
  }
  let value = fileHashes.get(file);
  if (!value) {
    value = file.arrayBuffer().then(bytes => globalThis.crypto.subtle.digest('SHA-256', bytes))
      .then(digest => Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join(''))
      .catch(() => { throw new Error('当前浏览器无法安全核验文件，未上传。请刷新或使用支持文件校验的浏览器。'); });
    fileHashes.set(file, value);
    void value.catch(() => fileHashes.delete(file));
  }
  return value;
}

function readImageDimensions(file: File): Promise<{ width: number | null; height: number | null }> {
  if (!file.type.startsWith('image/')) return Promise.resolve({ width: null, height: null });
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth || null, height: image.naturalHeight || null });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: null, height: null });
    };
    image.src = url;
  });
}

function readMediaMetadata(file: File): Promise<{ durationSeconds: number | null; width: number | null; height: number | null }> {
  if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) {
    return Promise.resolve({ durationSeconds: null, width: null, height: null });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const isVideo = file.type.startsWith('video/');
    const media = document.createElement(isVideo ? 'video' : 'audio');
    media.preload = 'metadata';
    media.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve({
        durationSeconds: Number.isFinite(media.duration) ? media.duration : null,
        width: isVideo ? (media as HTMLVideoElement).videoWidth || null : null,
        height: isVideo ? (media as HTMLVideoElement).videoHeight || null : null,
      });
    };
    media.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ durationSeconds: null, width: null, height: null });
    };
    media.src = url;
  });
}

function validateClientMediaDuration(file: File, durationSeconds: number | null) {
  if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) return;
  void durationSeconds;
}

function putFileToStorage(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress?: UploadProgressHandler,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    notifyUploadProgress(onProgress, {
      phase: 'storage',
      label: '正在上传到对象存储',
      loadedBytes: 0,
      totalBytes: file.size,
    });
    xhr.upload.onprogress = (event) => {
      notifyUploadProgress(onProgress, {
        phase: 'storage',
        label: '正在上传到对象存储',
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : file.size,
      });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`上传到对象存储失败（HTTP ${xhr.status || '未知'}）`));
      }
    };
    xhr.onerror = () => reject(new Error('上传到对象存储失败，请检查网络或稍后重试。'));
    xhr.ontimeout = () => reject(new Error(uploadStageTimeoutMessage('上传到对象存储')));
    xhr.timeout = calculateUploadTimeoutMs(file.size);
    xhr.send(file);
  });
}

async function uploadFileToHistoryInternal(
  file: File,
  options: UploadOptions = {},
) {
  const invalidJsonMessage = options.invalidJsonMessage || DEFAULT_UPLOAD_INVALID_JSON_MESSAGE;
  const fallbackToRaw = options.preserveUnknown ? false : options.fallbackToRaw !== false;
  const onProgress = options.onProgress;
  let hash = '';
  let width: number | null = null;
  let height: number | null = null;
  let durationSeconds: number | null = null;

  notifyUploadProgress(onProgress, {
    phase: 'preparing',
    label: '正在读取文件信息',
  });

  const [nextHash, imageDimensions, mediaMetadata] = await Promise.all([
    sha256File(file),
    readImageDimensions(file),
    readMediaMetadata(file),
  ]);
  hash = nextHash;
  width = mediaMetadata?.width ?? imageDimensions.width;
  height = mediaMetadata?.height ?? imageDimensions.height;
  durationSeconds = mediaMetadata?.durationSeconds ?? null;

  validateClientMediaDuration(file, durationSeconds);

  const uploadContext = {
    hash,
    width,
    height,
    durationSeconds,
    ownerId: options.ownerId,
    requestId: options.requestId,
  };
  const recoveredRaw = await recoverRawUpload(file, uploadContext, invalidJsonMessage, onProgress);
  if (recoveredRaw) return recoveredRaw;
  const restored = await options.beforeUpload?.({ hash, fileSize: file.size, mimeType: file.type });
  if (restored?.id) return restored;
  const receiptScope = `${options.ownerId || 'unscoped'}:${uploadSession().epoch}`;
  const receiptKey = options.ownerId ? `sd2:direct-upload:v1:${options.ownerId}:${hash}:${file.size}:${file.type}` : null;
  let pendingTicket = directReceipts.get(file)?.scope === receiptScope ? directReceipts.get(file)?.ticket : undefined;
  if (!pendingTicket && receiptKey) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(receiptKey) || 'null');
      if (saved && typeof saved.uploadToken === 'string' && saved.uploadToken.length < 20000) pendingTicket = saved;
    } catch { throw new Error('原上传凭据无法读取，未重新发送文件。请先核对我的素材。'); }
  }
  const retainTicket = (ticket: DirectUploadTicketResponse) => {
    // Keep exact signed identity before sending bytes. Never save credentials or public URLs.
    const receipt = { uploadToken: ticket.uploadToken, storageProvider: ticket.storageProvider };
    directReceipts.set(file, { scope: receiptScope, ticket: receipt });
    if (receiptKey) sessionStorage.setItem(receiptKey, JSON.stringify(receipt));
  };
  const finishTicket = async (ticket: DirectUploadTicketResponse) => {
    notifyUploadProgress(onProgress, { phase: 'complete', label: '正在核对原上传结果' });
    let response: Response;
    try { response = await fetch('/api/assets/upload-complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadToken: ticket.uploadToken, hash, width, height, durationSeconds }), signal: AbortSignal.timeout(calculateUploadTimeoutMs(file.size)) }); }
    catch (cause) { throw new UploadFileError('原上传登记结果待确认；再次点击上传只核对原凭据，不会重传文件。', { stage: 'direct-complete', recovery: 'query', cause }); }
    let result: UploadAssetResponse;
    try { result = await readUploadJsonResponse<UploadAssetResponse>(response, '原上传登记', invalidJsonMessage); }
    catch (cause) { throw new UploadFileError(cause instanceof Error ? cause.message : '原上传登记返回内容无效。', { stage: 'direct-complete', recovery: 'query', cause }); }
    if (!response.ok && result.notAccepted === true && result.code === 'UPLOAD_NOT_ACCEPTED') {
      directReceipts.delete(file); if (receiptKey) sessionStorage.removeItem(receiptKey);
      throw new UploadNotAcceptedError(result.error || '服务器确认原文件未被接收，可以安全重试上传。', {
        code: 'UPLOAD_NOT_ACCEPTED', causeCode: safeUploadDiagnostic(result.causeCode),
        stage: safeUploadDiagnostic(result.errorStage) || 'direct-complete',
      });
    }
    if (!response.ok || !result.asset?.id) throw responseUploadError(result, '原上传结果尚未确认，未重传文件。', 'query', 'direct-complete');
    directReceipts.delete(file);
    if (receiptKey) sessionStorage.removeItem(receiptKey);
    notifyUploadProgress(onProgress, { phase: 'done', label: result.asset.reused ? '已复用相同素材' : '上传完成', loadedBytes: file.size, totalBytes: file.size });
    return result.asset;
  };
  if (pendingTicket) {
    try { return await finishTicket(pendingTicket); }
    catch (cause) { if (!(cause instanceof UploadNotAcceptedError)) throw cause; }
  }
  const multipartAsset = await uploadWithMultipart(file, uploadContext, invalidJsonMessage, onProgress, true);
  if (multipartAsset?.id) return multipartAsset;

  notifyUploadProgress(onProgress, {
    phase: 'ticket',
    label: '正在申请上传通道',
  });

  let ticket: DirectUploadTicketResponse;
  let ticketRes: Response;
  try {
    ticketRes = await fetch('/api/assets/upload-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name || 'upload.bin',
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        hash,
        width,
        height,
        durationSeconds,
        requestId: options.requestId,
        ownerId: options.ownerId,
      }),
    });
  } catch (error) {
    const message = uploadStageConnectionMessage('上传票据创建', error);
    return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, message, onProgress, uploadContext);
  }
  try {
    ticket = await readUploadJsonResponse<DirectUploadTicketResponse>(ticketRes, '上传票据接口', invalidJsonMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传票据接口解析失败';
    return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, message, onProgress, uploadContext);
  }
  if (!ticketRes.ok) {
    const message = ticket.error || ticket.message || '上传票据创建失败';
    if (options.preserveUnknown && ticketRes.status >= 400 && ticketRes.status < 500) throw new UploadNotAcceptedError(message);
    if (ticketRes.status >= 500) {
      return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, message, onProgress, uploadContext);
    }
    throw new Error(message);
  }
  if (ticket.reused === true && ticket.asset?.id) {
    notifyUploadProgress(onProgress, {
      phase: 'done',
      label: '已复用相同素材',
      loadedBytes: file.size,
      totalBytes: file.size,
    });
    return ticket.asset;
  }
  if (ticket.directUploadAvailable === false) {
    if (shouldUseRawFallback(file, fallbackToRaw)) {
      return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, ticket.reason || '直传暂不可用', onProgress, uploadContext);
    }
    if (ticket.uploadToken && ticket.storageProvider === 'r2') {
      retainTicket(ticket);
      try {
        const asset = await uploadWithServerProxy(ticket, file, uploadContext, invalidJsonMessage, onProgress);
        directReceipts.delete(file); if (receiptKey) sessionStorage.removeItem(receiptKey);
        return asset;
      } catch (proxyError) {
        const proxyMessage = proxyError instanceof Error ? proxyError.message : '服务端中转上传失败';
        throw new Error(rawFallbackUnavailableMessage(`${ticket.reason || '直传暂不可用'}；服务端中转也失败：${proxyMessage}`, file));
      }
    }
    return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, ticket.reason || '直传暂不可用', onProgress, uploadContext);
  }
  if (!ticket.uploadUrl || !ticket.uploadToken || ticket.method !== 'PUT') {
    throw new Error('上传票据内容不完整，请刷新后重试。');
  }

  retainTicket(ticket);
  try {
    await putFileToStorage(ticket.uploadUrl, ticket.headers || {}, file, onProgress);
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传到对象存储失败';
    throw new UploadFileError(`${message}；原上传结果待确认，未切换链路重传。再次上传将核对原凭据。`, {
      stage: 'direct-upload', recovery: 'query', cause: error,
    });
  }
  return finishTicket(ticket);
}

export async function uploadFileToHistory(file: File, options: UploadOptions = {}): Promise<UploadedAssetPayload> {
  const session = uploadSession();
  const ownerId = options.ownerId || options.batch?.ownerId || session.ownerId || undefined;
  if (!ownerId) throw new Error('当前账号尚未确认，文件未上传。请重新登录后再选择文件。');
  if (session.ownerId && ownerId !== session.ownerId || options.batch && (options.batch.ownerId !== ownerId || options.batch.epoch !== session.epoch)) {
    throw new Error('账号已变化，请重新选择素材；原上传不会跨账号套用。');
  }
  const scope = `${ownerId || 'unscoped'}:${session.epoch}`;
  let identities = fileRequests.get(file);
  if (!identities) { identities = new Map(); fileRequests.set(file, identities); }
  const hash = await sha256File(file);
  const pendingRaw = readRawMarker(file, { ownerId, hash });
  if (pendingRaw && options.requestId && options.requestId !== pendingRaw.requestId) {
    throw new Error('原上传尚待确认，不能切换上传编号；请先查询原上传。');
  }
  const key = options.beforeUpload ? '' : `${scope}:${hash}:${file.size}:${file.type}`;
  const existing = key ? options.batch?.requests.get(key) || inFlightUploads.get(key) : undefined;
  if (existing) {
    notifyUploadProgress(options.onProgress, { phase: 'preparing', label: '正在复用本批相同文件' });
    const result = await existing;
    if (uploadSession().epoch !== session.epoch) throw new Error('账号已变化，原上传结果未套用。');
    notifyUploadProgress(options.onProgress, { phase: 'done', label: '已复用相同素材', loadedBytes: file.size, totalBytes: file.size });
    return { ...result, reused: true, ...(result.upload ? { upload: { ...result.upload, assetDisposition: 'reused' } } : {}) };
  }
  const identityKey = key ? `sd2:upload-request:v1:${key}` : null;
  let persistedId: string | null = null;
  if (identityKey) {
    try {
      persistedId = sessionStorage.getItem(identityKey);
      if (persistedId && !/^[a-zA-Z0-9-]{16,100}$/.test(persistedId)) throw new Error('Invalid receipt');
    } catch { throw new Error('原上传编号无法读取，未发送文件，请先核对我的素材。'); }
  }
  const requestId = pendingRaw?.requestId || options.requestId || persistedId || identities.get(scope) || crypto.randomUUID();
  identities.set(scope, requestId);
  if (identityKey) {
    try {
      sessionStorage.setItem(identityKey, requestId);
      if (sessionStorage.getItem(identityKey) !== requestId) throw new Error('Upload request unavailable');
    }
    catch { throw new Error('上传编号未能保存，文件尚未发送。请允许本机存储后重试。'); }
  }
  const request = uploadFileToHistoryInternal(file, { ...options, ownerId, requestId }).then(result => {
    if (uploadSession().epoch !== session.epoch) throw new Error('账号已变化，文件已由原账号处理，当前页面未套用。');
    if (identityKey) sessionStorage.removeItem(identityKey);
    return result;
  });
  if (key) { inFlightUploads.set(key, request); options.batch?.requests.set(key, request); }
  try { return await request; }
  catch (error) {
    if (key && options.batch?.requests.get(key) === request) options.batch.requests.delete(key);
    throw error;
  }
  finally { if (key && inFlightUploads.get(key) === request) inFlightUploads.delete(key); }
}

export const uploadFileAsAsset = uploadFileToHistory;
