'use client';

// Only an explicit user action hands the authorized resource to the browser's download manager.
export async function handImageDownloadToBrowser(url: string, fileName: string, isCurrent: () => boolean = () => true) {
  const target = new URL(url, location.href);
  if (target.origin !== location.origin || !target.pathname.startsWith('/api/')) throw Error('下载地址无效');
  const response = await fetch(target, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
  if (!isCurrent()) throw new DOMException('已离开当前结果，下载准备已取消', 'AbortError');
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw Error(value?.error || '下载权限或文件暂时无法确认，请重试');
  }
  if (!/^(image\/|application\/zip)/.test(response.headers.get('content-type') || '')) throw Error('下载未返回图片或图片包，请重新登录后重试');
  const anchor = document.createElement('a'); anchor.href = target.href; anchor.download = fileName; anchor.rel = 'noopener';
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
}
