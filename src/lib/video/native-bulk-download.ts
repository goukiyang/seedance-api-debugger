'use client';
import type { BulkVideoDownloadRequest } from './download-client';

export function handBulkVideoZipToBrowser(payload: BulkVideoDownloadRequest, onError: (message: string) => void) {
  const frame = document.createElement('iframe');
  frame.name = `sd2-download-${crypto.randomUUID()}`; frame.hidden = true;
  frame.setAttribute('sandbox', 'allow-downloads allow-same-origin');
  const form = document.createElement('form'); form.method = 'POST'; form.action = '/api/video/bulk-download'; form.target = frame.name;
  const input = document.createElement('input'); input.type = 'hidden'; input.name = 'payload'; input.value = JSON.stringify(payload); form.appendChild(input);
  let timeout: ReturnType<typeof setTimeout>;
  const cleanup = () => { clearTimeout(timeout); frame.remove(); };
  frame.addEventListener('load', () => {
    try {
      const href = frame.contentWindow?.location.href;
      if (!href || href === 'about:blank') return;
      const text = frame.contentDocument?.body?.textContent || '';
      const data = JSON.parse(text);
      if (data.error) onError(String(data.error).slice(0, 300));
      else onError('下载没有返回视频包，请确认登录状态后重试');
    } catch { onError('下载未返回可确认的视频包，请在浏览器下载列表查看或重试'); }
    cleanup();
  });
  document.body.append(frame, form); form.submit(); form.remove();
  timeout = setTimeout(cleanup, 5 * 60_000);
  return cleanup;
}
