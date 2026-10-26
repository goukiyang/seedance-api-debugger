export const BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT = 20;

export type BulkVideoDownloadRequest = {
  taskIds?: string[];
  projectId?: string;
};

export type BulkVideoDownloadClientResult = {
  blob: Blob;
  fileName: string;
  total: number;
  success: number;
  failed: number;
};

export type BulkVideoDownloadOptions = {
  signal?: AbortSignal;
  canDownload?: () => boolean;
};

const CURRENT_PRODUCTION_ORIGIN = 'https://sd2.youdooart.com';
const LEGACY_PRODUCTION_ORIGIN = 'https://sd2.youdoodesign.com';

function fallbackZipName() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `seedance-videos-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

function fileNameFromDisposition(value: string | null) {
  if (!value) return fallbackZipName();
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
  const match = /filename="?([^";]+)"?/i.exec(value);
  return match?.[1] || fallbackZipName();
}

function triggerDownload(blob: Blob, fileName: string, options?: BulkVideoDownloadOptions) {
  const url = URL.createObjectURL(blob);
  let triggered = false;
  try {
    ensureDownloadAllowed(options);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    try {
      ensureDownloadAllowed(options);
      anchor.click();
      triggered = true;
    } finally {
      anchor.remove();
    }
  } finally {
    if (triggered) {
      // Keep the object URL alive until the browser has accepted the download.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else {
      URL.revokeObjectURL(url);
    }
  }
}

async function errorMessageFromResponse(response: Response) {
  try {
    const data = await response.json();
    return data.message || data.error || '批量下载失败';
  } catch {
    return '批量下载失败';
  }
}

function ensureDownloadAllowed(options?: BulkVideoDownloadOptions) {
  if (options?.signal?.aborted || options?.canDownload?.() === false) {
    const error = new Error('The download was cancelled because its account context changed.');
    error.name = 'AbortError';
    throw error;
  }
}

function isLegacyOrigin() {
  return typeof window !== 'undefined'
    && window.location.origin === LEGACY_PRODUCTION_ORIGIN;
}

function networkDownloadErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (isLegacyOrigin()) {
    return `当前打开的是旧入口 ${LEGACY_PRODUCTION_ORIGIN}，这个入口已经停用。请改用 ${CURRENT_PRODUCTION_ORIGIN} 后重新登录再下载。`;
  }
  if (message === 'Failed to fetch') {
    return '批量下载请求没有连上服务器。请刷新页面后重试；如果仍出现，请确认当前网址是 https://sd2.youdooart.com。';
  }
  return message || '批量下载失败';
}

export async function downloadBulkVideoZip(
  payload: BulkVideoDownloadRequest,
  onStage?: (stage: string) => void,
  options?: BulkVideoDownloadOptions,
): Promise<BulkVideoDownloadClientResult> {
  ensureDownloadAllowed(options);
  onStage?.('正在打包视频…');
  let response: Response;
  try {
    response = await fetch('/api/video/bulk-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    ensureDownloadAllowed(options);
    throw new Error(networkDownloadErrorMessage(error));
  }

  ensureDownloadAllowed(options);
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('application/zip')) {
    const message = await errorMessageFromResponse(response);
    ensureDownloadAllowed(options);
    throw new Error(message);
  }

  const fileName = fileNameFromDisposition(response.headers.get('content-disposition'));
  ensureDownloadAllowed(options);
  onStage?.('正在接收视频包…');
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    ensureDownloadAllowed(options);
    throw new Error('视频包接收中断，请重新下载');
  }
  ensureDownloadAllowed(options);
  if (!blob.size) throw new Error('收到的视频包为空，请重新下载');
  triggerDownload(blob, fileName, options);

  return {
    blob,
    fileName,
    total: Number(response.headers.get('x-bulk-download-total') || 0),
    success: Number(response.headers.get('x-bulk-download-success') || 0),
    failed: Number(response.headers.get('x-bulk-download-failed') || 0),
  };
}
