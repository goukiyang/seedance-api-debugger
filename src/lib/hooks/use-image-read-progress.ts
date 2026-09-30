'use client';

import { useEffect, useState } from 'react';
import { createUploadProgressSnapshot } from '@/lib/http/upload-progress';

type ReadPhase = 'reading' | 'decoding' | 'unavailable' | 'unsupported';

export type ImageReadProgress = {
  phase: ReadPhase;
  loadedBytes: number;
  totalBytes?: number;
  percent?: number;
  message?: string;
};

type ImageReadResult = {
  imageSrc: string | null;
  progress: ImageReadProgress;
};

const READ_TIMEOUT_MS = 30_000;
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

function isVideoSource(source: string, mediaType: string) {
  if (mediaType.startsWith('video/')) return true;
  try {
    return /\.(?:avi|m4v|m3u8|mov|mp4|mpeg?|webm)$/i.test(new URL(source, window.location.href).pathname);
  } catch {
    return false;
  }
}

function responseLength(response: Response, source: string) {
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  const rawLength = response.headers.get('content-length');
  if (encoding && encoding !== 'identity') return undefined;
  if (!encoding && new URL(response.url || source, window.location.href).origin !== window.location.origin) return undefined;
  if (!rawLength || !/^\d+$/.test(rawLength)) return undefined;
  const parsedLength = Number(rawLength);
  return Number.isSafeInteger(parsedLength) && parsedLength > 0 ? parsedLength : undefined;
}

export function useImageReadProgress(source: string, attempt: number): ImageReadResult {
  const requestKey = `${source}\u0000${attempt}`;
  const [entry, setEntry] = useState<(ImageReadResult & { key: string }) | null>(null);

  useEffect(() => {
    let current = true;
    let nativeFallbackStarted = false;
    let objectUrl: string | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let progressFrame = 0;
    let pendingProgress: ImageReadProgress | null = null;
    let timeout: number | undefined;
    const controller = new AbortController();

    const resetReadTimeout = () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        timeout = undefined;
        showNativeImage('读取时间较长，改由浏览器打开图片');
      }, READ_TIMEOUT_MS);
    };

    const update = (progress: ImageReadProgress, imageSrc: string | null = null) => {
      if (!current || controller.signal.aborted) return;
      setEntry({ key: requestKey, imageSrc, progress });
    };

    const showNativeImage = (message: string) => {
      if (!current || nativeFallbackStarted) return;
      nativeFallbackStarted = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = undefined;
      controller.abort();
      setEntry({
        key: requestKey,
        imageSrc: source,
        progress: { phase: 'unavailable', loadedBytes: 0, message },
      });
      if (progressFrame) window.cancelAnimationFrame(progressFrame);
      progressFrame = 0;
      pendingProgress = null;
      if (reader) void reader.cancel().catch(() => {});
    };

    const showUnsupportedSource = () => {
      if (!current || nativeFallbackStarted) return;
      nativeFallbackStarted = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = undefined;
      controller.abort();
      setEntry({
        key: requestKey,
        imageSrc: null,
        progress: { phase: 'unsupported', loadedBytes: 0, message: '该来源不是图片，未读取文件内容' },
      });
      if (progressFrame) window.cancelAnimationFrame(progressFrame);
      progressFrame = 0;
      pendingProgress = null;
      if (reader) void reader.cancel().catch(() => {});
    };

    setEntry({ key: requestKey, imageSrc: null, progress: { phase: 'reading', loadedBytes: 0 } });
    resetReadTimeout();

    const reportProgress = (progress: ImageReadProgress) => {
      pendingProgress = progress;
      if (progressFrame) return;
      progressFrame = window.requestAnimationFrame(() => {
        progressFrame = 0;
        const pending = pendingProgress;
        pendingProgress = null;
        if (pending) update(pending);
      });
    };

    const readImage = async () => {
      if (/^(?:blob:|data:)/i.test(source)) {
        showNativeImage('本地图片由浏览器直接打开');
        return;
      }
      if (isVideoSource(source, '')) {
        showUnsupportedSource();
        return;
      }

      let response: Response;
      try {
        response = await fetch(source, { signal: controller.signal, cache: 'default' });
      } catch {
        if (current && !controller.signal.aborted) showNativeImage('当前来源无法提供读取进度');
        return;
      }

      if (!current || controller.signal.aborted) return;
      if (!response.ok) {
        showNativeImage('读取进度不可用，改由浏览器打开图片');
        return;
      }

      const mediaType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (isVideoSource(source, mediaType)) {
        showUnsupportedSource();
        return;
      }
      if (!mediaType.startsWith('image/') || !response.body) {
        showNativeImage('当前来源无法提供读取进度');
        return;
      }

      reader = response.body.getReader();
      let totalBytes = responseLength(response, source);
      let loadedBytes = 0;
      const chunks: ArrayBuffer[] = [];
      if (totalBytes != null && totalBytes > MAX_BUFFERED_BYTES) {
        showNativeImage('图片较大，改由浏览器直接打开');
        return;
      }

      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!current || controller.signal.aborted) return;
        loadedBytes += result.value.byteLength;
        if (loadedBytes > MAX_BUFFERED_BYTES) {
          chunks.length = 0;
          showNativeImage('图片较大，改由浏览器直接打开');
          return;
        }
        const chunk = result.value.slice();
        chunks.push(chunk.buffer as ArrayBuffer);
        if (totalBytes != null && loadedBytes > totalBytes) totalBytes = undefined;
        resetReadTimeout();
        const snapshot = totalBytes == null ? undefined : createUploadProgressSnapshot({
          phase: 'image-read',
          label: '大图读取',
          loadedBytes,
          totalBytes,
        });
        const percent = snapshot?.percent == null ? undefined : Math.min(99, snapshot.percent);
        reportProgress({
          phase: 'reading',
          loadedBytes,
          ...(totalBytes != null ? { totalBytes } : {}),
          ...(percent != null ? { percent } : {}),
        });
      }

      if (!current || controller.signal.aborted) return;
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = undefined;
      if (progressFrame) window.cancelAnimationFrame(progressFrame);
      progressFrame = 0;
      pendingProgress = null;

      if (totalBytes != null && loadedBytes !== totalBytes) totalBytes = undefined;

      if (!chunks.length) {
        showNativeImage('当前来源无法提供读取进度');
        return;
      }

      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim() || 'application/octet-stream';
      objectUrl = URL.createObjectURL(new Blob(chunks, { type: contentType }));
      update({
        phase: 'decoding',
        loadedBytes,
        ...(totalBytes != null ? { totalBytes, percent: 100 } : {}),
      }, objectUrl);
    };

    void readImage().catch(() => {
      if (current && !controller.signal.aborted) showNativeImage('当前来源无法提供读取进度');
    });

    return () => {
      current = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (progressFrame) window.cancelAnimationFrame(progressFrame);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [requestKey, source]);

  if (entry?.key === requestKey) {
    const { key: _key, ...result } = entry;
    return result;
  }
  return { imageSrc: null, progress: { phase: 'reading', loadedBytes: 0 } };
}
