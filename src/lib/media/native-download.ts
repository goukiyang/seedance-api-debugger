'use client';

import { imageDisplaySource } from './image-comparison';
import { borrowImageRead, captureImageReadSessionScope, invalidateImageReadSource } from './image-read-session';

// Only an explicit user action hands the authorized resource to the browser's download manager.
export async function handImageDownloadToBrowser(url: string, fileName: string, isCurrent: () => boolean = () => true) {
  const target = new URL(url, location.href);
  if (target.origin !== location.origin || !target.pathname.startsWith('/api/')) throw Error('下载地址无效');
  const response = await fetch(target, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
  if (!isCurrent()) throw new DOMException('已离开当前结果，下载准备已取消', 'AbortError');
  if (!response.ok) {
    if ([401, 403, 404].includes(response.status)) invalidateImageReadSource(url);
    const value = await response.json().catch(() => null);
    throw Error(value?.error || '下载权限或文件暂时无法确认，请重试');
  }
  if (!/^(image\/|application\/zip)/.test(response.headers.get('content-type') || '')) throw Error('下载未返回图片或图片包，请重新登录后重试');
  const anchor = document.createElement('a'); anchor.href = target.href; anchor.download = fileName; anchor.rel = 'noopener';
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
}

function hdDownloadName(fileName: string, mime: string) {
  const subtype = mime.slice('image/'.length);
  const extension = ({ jpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico' } as Record<string, string>)[subtype]
    || (/^[a-z0-9]+$/.test(subtype) ? subtype : '');
  if (!extension) throw Error('高清图片格式暂时无法确认，请重新打开后重试');
  const base = fileName.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\.[^.]*$/, '').replace(/-hd$/i, '').trim() || 'image';
  return `${base}-hd.${extension}`;
}

// The fresh HEAD authorizes this exact HD version. A cache miss remains a native
// streaming download; never buffer an original or compare cross-variant ETags.
export async function handHdImageDownloadToBrowser(options: {
  account: string; source: string; sourceVersion: string; representationVersion?: string; fileName: string; isCurrent: () => boolean;
}): Promise<{ reused: boolean; bytes: number; mime: string }> {
  const { account, source, sourceVersion, representationVersion, fileName, isCurrent } = options;
  const inScope = captureImageReadSessionScope(account);
  const ensureCurrent = () => {
    if (!inScope() || !isCurrent()) throw new DOMException('已离开当前结果，下载准备已取消', 'AbortError');
  };
  ensureCurrent();
  const original = new URL(source, location.href);
  if (original.origin !== location.origin || original.username || original.password
    || !/^\/api\/(?:image-studio\/(?:(?:assets|template-assets)\/[^/]+|style-groups\/[^/]+\/assets\/[^/]+)|reference-images\/[^/]+\/content|content-reactions\/media)$/.test(original.pathname)
    || !sourceVersion || sourceVersion !== sourceVersion.trim() || sourceVersion.length > 256) throw Error('高清下载地址或版本无效，请重新打开图片');
  const versionedSource = (mode: 'hd' | 'hd-download') => {
    const target = new URL(imageDisplaySource(`${original.pathname}${original.search}`, mode), location.href);
    target.hash = ''; target.searchParams.set('hd-version', sourceVersion);
    if (representationVersion) target.searchParams.set('hd-representation', representationVersion);
    return target;
  };
  const target = versionedSource('hd-download');
  const response = await fetch(target, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', signal: AbortSignal.timeout(15000) });
  if ([401, 403, 404].includes(response.status) && inScope()) invalidateImageReadSource(source, account);
  ensureCurrent();
  if (response.status !== 200) {
    if (response.status === 409) throw Error('高清图已更新或尚未准备好，请重新打开后下载');
    throw Error('高清下载权限或文件暂时无法确认，请重试');
  }
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
  const length = response.headers.get('content-length') || '', bytes = Number(length);
  const encoding = response.headers.get('content-encoding');
  if (response.headers.get('X-Image-Source-Version') !== sourceVersion || !/^image\/[a-z0-9][a-z0-9.+_-]*$/.test(mime)
    || representationVersion && response.headers.get('X-Image-Representation-Version') !== representationVersion
    || !/^[1-9]\d*$/.test(length) || !Number.isSafeInteger(bytes) || bytes <= 0 || response.headers.has('content-range')
    || encoding && encoding !== 'identity' || response.url && new URL(response.url).origin !== location.origin) {
    invalidateImageReadSource(source, account);
    throw Error('高清图片版本或完整文件信息已变化，请重新打开后下载');
  }
  const downloadName = hdDownloadName(fileName, mime);
  ensureCurrent();
  const borrowed = borrowImageRead(account, versionedSource('hd').href, sourceVersion, { sourceVersion, representationVersion, bytes, mime, variant: 'hd', policy: 'hd-f-v1' });
  let objectUrl: string | undefined, handedToBrowser = false;
  try {
    ensureCurrent();
    if (borrowed && !borrowed.isValid()) throw new DOMException('图片已变化，下载准备已取消', 'AbortError');
    if (borrowed) objectUrl = URL.createObjectURL(borrowed.blob);
    const anchor = document.createElement('a'); anchor.href = objectUrl || target.href; anchor.download = downloadName; anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    try {
      ensureCurrent();
      if (borrowed && !borrowed.isValid()) throw new DOMException('图片已变化，下载准备已取消', 'AbortError');
      anchor.click(); handedToBrowser = true;
    } finally { anchor.remove(); }
  } finally {
    const release = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); borrowed?.release(); };
    // Match the existing video download handoff grace period; this is not a
    // download-completed/landed signal, and the borrow stays budgeted until here.
    if (handedToBrowser && objectUrl) setTimeout(release, 60_000);
    else release();
  }
  return { reused: Boolean(borrowed), bytes, mime };
}
