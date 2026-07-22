export type UploadProgressSnapshot = {
  phase: string;
  label: string;
  loadedBytes?: number;
  totalBytes?: number;
  percent?: number;
};

export type UploadProgressHandler = (progress: UploadProgressSnapshot) => void;

type ProgressInput = {
  phase: string;
  label: string;
  loadedBytes?: number;
  totalBytes?: number;
};

type JsonUploadRequest<T> = {
  url: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  body: XMLHttpRequestBodyInit | Document;
  invalidJsonMessage: string;
  connectionMessage: string;
  progress: {
    phase: string;
    label: string;
    totalBytes?: number;
  };
  onProgress?: UploadProgressHandler;
  timeoutMs?: number;
};

export function createUploadProgressSnapshot(input: ProgressInput): UploadProgressSnapshot {
  const totalBytes = Number.isFinite(input.totalBytes) && input.totalBytes! > 0
    ? input.totalBytes
    : undefined;
  const loadedBytes = Number.isFinite(input.loadedBytes)
    ? Math.max(0, input.loadedBytes!)
    : undefined;
  const percent = totalBytes && loadedBytes != null
    ? Math.max(0, Math.min(100, Math.round((loadedBytes / totalBytes) * 100)))
    : undefined;

  return {
    phase: input.phase,
    label: input.label,
    ...(loadedBytes != null ? { loadedBytes } : {}),
    ...(totalBytes != null ? { totalBytes } : {}),
    ...(percent != null ? { percent } : {}),
  };
}

export function notifyUploadProgress(
  onProgress: UploadProgressHandler | undefined,
  input: ProgressInput,
) {
  if (!onProgress) return;
  onProgress(createUploadProgressSnapshot(input));
}

export function requestJsonWithUploadProgress<T>({
  url,
  method = 'POST',
  headers = {},
  body,
  invalidJsonMessage,
  connectionMessage,
  progress,
  onProgress,
  timeoutMs = 120000,
}: JsonUploadRequest<T>): Promise<{ ok: boolean; status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.timeout = timeoutMs;
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));

    notifyUploadProgress(onProgress, {
      phase: progress.phase,
      label: progress.label,
      loadedBytes: 0,
      totalBytes: progress.totalBytes,
    });

    xhr.upload.onprogress = (event) => {
      notifyUploadProgress(onProgress, {
        phase: progress.phase,
        label: progress.label,
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : progress.totalBytes,
      });
    };

    xhr.onload = () => {
      const text = xhr.responseText || '';
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        reject(new Error(invalidJsonMessage));
        return;
      }
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        data,
      });
    };
    xhr.onerror = () => reject(new Error(connectionMessage));
    xhr.onabort = () => reject(new Error(connectionMessage));
    xhr.ontimeout = () => reject(new Error(connectionMessage));
    xhr.send(body);
  });
}
