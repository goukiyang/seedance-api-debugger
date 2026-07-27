import { readJsonResponse } from './json-response';
import {
  notifyUploadProgress,
  requestJsonWithUploadProgress,
  type UploadProgressHandler,
  type UploadProgressSnapshot,
} from './upload-progress';

export type { UploadProgressHandler, UploadProgressSnapshot };

const DEFAULT_UPLOAD_INVALID_JSON_MESSAGE = '素材上传服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';
const MEDIA_DURATION_MIN_SECONDS = 2;
const MEDIA_DURATION_MAX_SECONDS = 15;
const RAW_FALLBACK_MAX_SIZE_BYTES = 8 * 1024 * 1024;

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

type UploadContext = {
  hash: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
};

export function buildRawFileUploadRequest(file: File): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'upload.bin'),
      'X-File-Size': String(file.size),
    },
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
  return `${stage}连接中断，系统没有拿到有效上传结果${detail}。请重新上传；如果文件较大，请压缩后重试。`;
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
) {
  let result: { ok: boolean; status: number; data: UploadAssetResponse };
  const request = buildRawFileUploadRequest(file);
  try {
    result = await requestJsonWithUploadProgress<UploadAssetResponse>({
      url: '/api/assets/upload',
      method: 'POST',
      headers: request.headers as Record<string, string>,
      body: file,
      invalidJsonMessage: uploadStageInvalidJsonMessage('普通上传接口', invalidJsonMessage),
      connectionMessage: uploadStageConnectionMessage('普通上传', new Error('网络中断')),
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
  return file.type.startsWith('image/') && file.size <= RAW_FALLBACK_MAX_SIZE_BYTES;
}

function shouldUseRawFallback(file: File, fallbackToRaw: boolean) {
  return fallbackToRaw && canUseRawFallback(file);
}

function rawFallbackUnavailableMessage(reason: string) {
  return `${reason.replace(/[。；;,.，]+$/, '')}。当前文件不能自动改用普通上传（仅支持 8MB 以内图片自动回退），请刷新页面或重新登录后重试；如果仍出现，请联系管理员确认 R2 CORS 已允许 https://sd2.youdoodesign.com 使用 PUT 和 Content-Type。`;
}

async function uploadWithRawFallbackOrThrow(
  file: File,
  invalidJsonMessage: string,
  fallbackToRaw: boolean,
  reason: string,
  onProgress?: UploadProgressHandler,
) {
  if (shouldUseRawFallback(file, fallbackToRaw)) {
    return uploadWithRawFallback(file, invalidJsonMessage, onProgress);
  }
  throw new Error(rawFallbackUnavailableMessage(reason));
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
  if (context.width != null) headers['X-Image-Width'] = String(context.width);
  if (context.height != null) headers['X-Image-Height'] = String(context.height);
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

async function uploadWithServerProxyOrThrow(
  ticket: DirectUploadTicketResponse,
  file: File,
  context: UploadContext,
  invalidJsonMessage: string,
  reasonPrefix: string,
  onProgress?: UploadProgressHandler,
) {
  try {
    return await uploadWithServerProxy(ticket, file, context, invalidJsonMessage, onProgress);
  } catch (proxyError) {
    const proxyMessage = proxyError instanceof Error ? proxyError.message : '服务端中转上传失败';
    throw new Error(rawFallbackUnavailableMessage(`${reasonPrefix}；服务端中转也失败：${proxyMessage}`));
  }
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

function readMediaDuration(file: File): Promise<number | null> {
  if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    media.preload = 'metadata';
    media.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(media.duration) ? media.duration : null);
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
    xhr.ontimeout = () => reject(new Error('上传到对象存储超时，请稍后重试。'));
    xhr.timeout = 120000;
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
    [hash, { width, height }, durationSeconds] = await Promise.all([
      sha256File(file),
      readImageDimensions(file),
      readMediaDuration(file),
    ]);
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
      }),
    });
  } catch (error) {
    const message = uploadStageConnectionMessage('上传票据创建', error);
    return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, message, onProgress);
  }
  try {
    ticket = await readUploadJsonResponse<DirectUploadTicketResponse>(ticketRes, '上传票据接口', invalidJsonMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传票据接口解析失败';
    return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, message, onProgress);
  }
  if (!ticketRes.ok) {
    const message = ticket.error || ticket.message || '上传票据创建失败';
    if (ticketRes.status >= 500) {
      return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, message, onProgress);
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
    if (ticket.uploadToken && ticket.storageProvider === 'r2') {
      return uploadWithServerProxyOrThrow(
        ticket,
        file,
        { hash, width, height, durationSeconds },
        invalidJsonMessage,
        ticket.reason || '直传暂不可用',
        onProgress,
      );
    }
    return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, ticket.reason || '直传暂不可用', onProgress);
  }
  if (!ticket.uploadUrl || !ticket.uploadToken || ticket.method !== 'PUT') {
    throw new Error('上传票据内容不完整，请刷新后重试。');
  }

  try {
    await putFileToStorage(ticket.uploadUrl, ticket.headers || {}, file, onProgress);
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传到对象存储失败';
    return uploadWithServerProxyOrThrow(
      ticket,
      file,
      { hash, width, height, durationSeconds },
      invalidJsonMessage,
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
    return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, message, onProgress);
  }
  try {
    complete = await readUploadJsonResponse<UploadAssetResponse>(completeRes, '上传完成登记接口', invalidJsonMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传完成登记接口解析失败';
    return uploadWithRawFallbackOrThrow(file, invalidJsonMessage, fallbackToRaw, message, onProgress);
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
