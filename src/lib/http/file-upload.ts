import { readJsonResponse } from './json-response';
import {
  calculateUploadTimeoutMs,
  notifyUploadProgress,
  requestJsonWithUploadProgress,
  type UploadProgressHandler,
  type UploadProgressSnapshot,
} from './upload-progress';

export type { UploadProgressHandler, UploadProgressSnapshot };

const DEFAULT_UPLOAD_INVALID_JSON_MESSAGE = '素材上传服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';
const MEDIA_DURATION_MIN_SECONDS = 2;
const MEDIA_DURATION_MAX_SECONDS = 15;
const IMAGE_RAW_FALLBACK_MAX_SIZE_BYTES = 30 * 1024 * 1024;
const AUDIO_RAW_FALLBACK_MAX_SIZE_BYTES = 15 * 1024 * 1024;
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
};

type UploadAssetResponse = {
  success?: boolean;
  asset?: UploadedAssetPayload;
  error?: string;
  message?: string;
};

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
  let result: { ok: boolean; status: number; data: UploadAssetResponse };
  const request = buildRawFileUploadRequest(file, context);
  try {
    result = await requestJsonWithUploadProgress<UploadAssetResponse>({
      url: '/api/assets/upload',
      method: 'POST',
      headers: request.headers as Record<string, string>,
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
  } catch (error) {
    if (error instanceof Error && error.message.includes('系统没有拿到有效上传结果')) throw error;
    throw new Error(uploadStageConnectionMessage('普通上传', error));
  }
  const data = result.data;
  if (!result.ok) throw new Error(data.error || data.message || '素材上传失败，请重新选择后重试');
  if (!data.asset?.id) throw new Error('素材上传成功，但没有返回素材 ID');
  notifyUploadProgress(onProgress, {
    phase: 'done',
    label: data.asset.reused ? '已复用相同素材' : '上传完成',
    loadedBytes: file.size,
    totalBytes: file.size,
  });
  return data.asset;
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
    return `${reason.replace(/[。；;,.，]+$/, '')}。当前视频不能自动改用普通上传；请联系管理员确认 R2 CORS 已允许 https://sd2.youdoodesign.com 使用 PUT、Content-Type 和 ETag，或启用视频分块上传验收路径。`;
  }
  return `${reason.replace(/[。；;,.，]+$/, '')}。当前文件不能自动改用普通上传（仅支持 30MB 以内图片或 15MB 以内音频自动回退），请刷新页面或重新登录后重试；如果仍出现，请联系管理员确认 R2 CORS 已允许 https://sd2.youdoodesign.com 使用 PUT 和 Content-Type。`;
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

async function uploadWithServerProxyOrRawFallback(
  ticket: DirectUploadTicketResponse,
  file: File,
  context: UploadContext,
  invalidJsonMessage: string,
  fallbackToRaw: boolean,
  reasonPrefix: string,
  onProgress?: UploadProgressHandler,
) {
  if (shouldUseRawFallback(file, fallbackToRaw)) {
    return uploadWithRawFallback(file, invalidJsonMessage, onProgress, context);
  }

  try {
    return await uploadWithServerProxy(ticket, file, context, invalidJsonMessage, onProgress);
  } catch (proxyError) {
    const proxyMessage = proxyError instanceof Error ? proxyError.message : '服务端中转上传失败';
    throw new Error(rawFallbackUnavailableMessage(`${reasonPrefix}；服务端中转也失败：${proxyMessage}`, file));
  }
}

function shouldUseMultipartUpload(file: File) {
  return file.type.startsWith('video/') && file.size > MULTIPART_UPLOAD_MIN_SIZE_BYTES;
}

function multipartResumeKey(file: File, hash: string) {
  return `${MULTIPART_RESUME_STORAGE_PREFIX}${hash}:${file.size}:${file.type || 'application/octet-stream'}`;
}

function readMultipartResumeState(file: File, hash: string): MultipartResumeState | null {
  if (typeof window === 'undefined') return null;
  const raw = sessionStorage.getItem(multipartResumeKey(file, hash));
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
      new Date(state.expiresAt).getTime() <= Date.now()
    ) {
      sessionStorage.removeItem(multipartResumeKey(file, hash));
      return null;
    }
    return {
      ...state,
      parts: Array.isArray(state.parts) ? state.parts.filter((part) => part.partNumber > 0 && part.eTag) : [],
    };
  } catch {
    sessionStorage.removeItem(multipartResumeKey(file, hash));
    return null;
  }
}

function writeMultipartResumeState(file: File, state: MultipartResumeState) {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(multipartResumeKey(file, state.hash), JSON.stringify(state));
}

function clearMultipartResumeState(file: File, hash: string) {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(multipartResumeKey(file, hash));
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
): Promise<UploadedAssetPayload | null> {
  if (!shouldUseMultipartUpload(file)) return null;

  let state = readMultipartResumeState(file, context.hash);
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
    if (!startRes.ok) throw new Error(start.error || start.message || '分块上传初始化失败');
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
    writeMultipartResumeState(file, state);
  }

  const completedParts = new Map<number, string>();
  for (const part of state.parts) completedParts.set(part.partNumber, part.eTag);
  const partCount = Math.ceil(file.size / state.partSize);
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
      writeMultipartResumeState(file, state!);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(MULTIPART_UPLOAD_CONCURRENCY, partCount) }, uploadNextPart));
  } catch (error) {
    if (state && !shouldKeepMultipartResumeState(error)) {
      await abortMultipartUpload(state.uploadToken, invalidJsonMessage);
      clearMultipartResumeState(file, context.hash);
    }
    throw error;
  }

  notifyUploadProgress(onProgress, {
    phase: 'multipart_complete',
    label: '正在合并上传结果',
    loadedBytes: file.size,
    totalBytes: file.size,
  });

  let completeRes: Response;
  try {
    completeRes = await fetch('/api/assets/multipart/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadToken: state.uploadToken,
        hash: context.hash,
        width: context.width,
        height: context.height,
        durationSeconds: context.durationSeconds,
        parts: state.parts,
      }),
    });
  } catch (error) {
    throw new Error(uploadStageConnectionMessage('分块上传完成登记', error));
  }
  const complete = await readUploadJsonResponse<UploadAssetResponse>(
    completeRes,
    '分块上传完成登记接口',
    invalidJsonMessage,
  );
  if (!completeRes.ok) {
    await abortMultipartUpload(state.uploadToken, invalidJsonMessage);
    clearMultipartResumeState(file, context.hash);
    throw new Error(complete.error || complete.message || '分块上传完成登记失败');
  }
  if (!complete.asset?.id) {
    await abortMultipartUpload(state.uploadToken, invalidJsonMessage);
    clearMultipartResumeState(file, context.hash);
    throw new Error('分块上传完成但没有返回素材 ID');
  }
  clearMultipartResumeState(file, context.hash);
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
    throw new Error('当前浏览器不支持文件校验，已回退到普通上传。');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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
      reject(new Error('无法读取视频/音频时长，请确认文件完整、格式正确后重试。'));
    };
    media.src = url;
  });
}

function validateClientMediaDuration(file: File, durationSeconds: number | null) {
  if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) return;
  const label = file.type.startsWith('video/') ? '视频' : '音频';
  if (!Number.isFinite(durationSeconds) || !durationSeconds) {
    throw new Error(`${label}时长读取失败，请确认文件完整、格式正确后重试。`);
  }
  if (durationSeconds < MEDIA_DURATION_MIN_SECONDS || durationSeconds > MEDIA_DURATION_MAX_SECONDS) {
    throw new Error(`${label}时长需为 ${MEDIA_DURATION_MIN_SECONDS}-${MEDIA_DURATION_MAX_SECONDS} 秒，当前约 ${durationSeconds.toFixed(1)} 秒。`);
  }
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

export async function uploadFileToHistory(
  file: File,
  options: { invalidJsonMessage?: string; fallbackToRaw?: boolean; onProgress?: UploadProgressHandler } = {},
) {
  const invalidJsonMessage = options.invalidJsonMessage || DEFAULT_UPLOAD_INVALID_JSON_MESSAGE;
  const fallbackToRaw = options.fallbackToRaw !== false;
  const onProgress = options.onProgress;
  let hash = '';
  let width: number | null = null;
  let height: number | null = null;
  let durationSeconds: number | null = null;

  notifyUploadProgress(onProgress, {
    phase: 'preparing',
    label: '正在读取文件信息',
  });

  try {
    const [nextHash, imageDimensions, mediaMetadata] = await Promise.all([
      sha256File(file),
      readImageDimensions(file),
      readMediaMetadata(file),
    ]);
    hash = nextHash;
    width = mediaMetadata?.width ?? imageDimensions.width;
    height = mediaMetadata?.height ?? imageDimensions.height;
    durationSeconds = mediaMetadata?.durationSeconds ?? null;
  } catch (error) {
    if (
      shouldUseRawFallback(file, fallbackToRaw) &&
      error instanceof Error &&
      error.message.includes('当前浏览器不支持文件校验')
    ) {
      return uploadWithRawFallback(file, invalidJsonMessage, onProgress);
    }
    throw error;
  }

  validateClientMediaDuration(file, durationSeconds);

  const uploadContext = {
    hash,
    width,
    height,
    durationSeconds,
  };
  const multipartAsset = await uploadWithMultipart(file, uploadContext, invalidJsonMessage, onProgress);
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
      try {
        return await uploadWithServerProxy(ticket, file, uploadContext, invalidJsonMessage, onProgress);
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

  try {
    await putFileToStorage(ticket.uploadUrl, ticket.headers || {}, file, onProgress);
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传到对象存储失败';
    return uploadWithServerProxyOrRawFallback(
      ticket,
      file,
      uploadContext,
      invalidJsonMessage,
      fallbackToRaw,
      message,
      onProgress,
    );
  }

  notifyUploadProgress(onProgress, {
    phase: 'complete',
    label: '正在登记上传结果',
  });

  let complete: UploadAssetResponse;
  let completeRes: Response;
  try {
    completeRes = await fetch('/api/assets/upload-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadToken: ticket.uploadToken,
        hash,
        width,
        height,
        durationSeconds,
      }),
    });
  } catch (error) {
    const message = uploadStageConnectionMessage('上传完成登记', error);
    return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, message, onProgress, uploadContext);
  }
  try {
    complete = await readUploadJsonResponse<UploadAssetResponse>(completeRes, '上传完成登记接口', invalidJsonMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传完成登记接口解析失败';
    return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, message, onProgress, uploadContext);
  }
  if (!completeRes.ok) {
    throw new Error(complete.error || complete.message || '上传完成但入库失败，请重新上传。');
  }
  if (!complete.asset?.id) throw new Error('上传完成但没有返回素材 ID');
  notifyUploadProgress(onProgress, {
    phase: 'done',
    label: '上传完成',
    loadedBytes: file.size,
    totalBytes: file.size,
  });
  return complete.asset;
}

export const uploadFileAsAsset = uploadFileToHistory;
