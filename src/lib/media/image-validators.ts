import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';

export function imageStatEtag(info: Stats, policy: string) {
  const fingerprint = [policy, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
  return `W/"${createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex')}"`;
}

export function imageEtagMatches(value: string | null, etag: string) {
  if (!value) return false;
  const tags = value.match(/(?:W\/)?"[^"\r\n]*"|\*/g) || [];
  return tags.some(tag => tag === '*' || tag.replace(/^W\//, '') === etag.replace(/^W\//, ''));
}

export function isImagePrefetch(request: Request) {
  return request.headers.get('x-image-read-intent') === 'prefetch';
}
