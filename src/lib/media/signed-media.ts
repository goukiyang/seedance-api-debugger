import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireSecret } from '@/lib/security/secrets';
import type { MediaRef } from '@/lib/access/media-policy';
import { checkedMediaFile, mediaInternalUri, safeMediaRelative, type MediaLocation } from './storage-roots';
import { imageEtagMatches, imageStatEtag } from './image-validators';
import { mediaDeliveryFile } from './delivery-cache';

type Claims = { v: 1; audience: 'user' | 'supplier'; userId: string | null; ref: { type: string; id: string }; variant: string;
  exp: number; location: MediaLocation; version: string; mime: string; name: string;
  sourceVersion?: string; comparisonVersion?: string; representationVersion?: string };
export const USER_MEDIA_TTL_SECONDS = 600;
export const SUPPLIER_MEDIA_TTL_SECONDS = 3600;
const passiveImageMimes = new Set(['image/png', 'image/x-png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/webp',
  'image/gif', 'image/avif', 'image/bmp', 'image/x-ms-bmp', 'image/tiff', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/heic', 'image/heif']);
const mediaMimeAllowed = (mime: string) => passiveImageMimes.has(mime.toLowerCase())
  || /^(?:video|audio)\/[a-zA-Z0-9.+-]+$/.test(mime) || mime === 'application/octet-stream';
const key = () => createHmac('sha256', requireSecret('media')).update('media-ticket-encryption-v1').digest();
const signature = (pathname: string, exp: string, ticket: string) => createHmac('sha256', requireSecret('media'))
  .update(JSON.stringify(['media-outlet-v1', pathname, exp, ticket])).digest('base64url');
const errorHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export const mediaDenied = (status = 403) => new Response(null, { status, headers: errorHeaders });

async function sign(claim: Omit<Claims, 'v' | 'version' | 'exp'>, ttl: number) {
  if (!mediaMimeAllowed(claim.mime)) throw Object.assign(new Error('media_mime_forbidden'), { status: 403 });
  const file = await checkedMediaFile(claim.location);
  const claims: Claims = { ...claim, sourceVersion: claim.sourceVersion || imageStatEtag(file.stat, `media-${claim.variant}-v1`),
    v: 1, version: file.version, exp: Math.floor(Date.now() / 1000) + ttl };
  const pathname = `/m/${encodeURIComponent(claim.ref.type)}/${encodeURIComponent(claim.ref.id)}/${encodeURIComponent(claim.variant)}`;
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), nonce);
  cipher.setAAD(Buffer.from(pathname));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  const ticket = Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
  const exp = String(claims.exp);
  return `${pathname}?${new URLSearchParams({ exp, ticket, sig: signature(pathname, exp, ticket) })}`;
}

export function signUserMedia(userId: string, ref: MediaRef, variant: string, location: MediaLocation, mime: string, name: string,
  versions: Pick<Claims, 'sourceVersion' | 'comparisonVersion' | 'representationVersion'> = {}) {
  return sign({ audience: 'user', userId, ref: { type: ref.type, id: ref.id }, variant, location, mime, name, ...versions }, USER_MEDIA_TTL_SECONDS);
}

// Only freshly published provider-delivery files may obtain an anonymous ticket.
// This is not a general API for making an arbitrary Asset public.
export function signSupplierMedia(id: string, relative: string, mime: string, name: string) {
  return sign({ audience: 'supplier', userId: null, ref: { type: 'supplier', id }, variant: 'original',
    location: { root: 'supplier', relative }, mime, name }, SUPPLIER_MEDIA_TTL_SECONDS);
}

export function verifyMediaTicket(url: URL, userId: string | null, now = Date.now()): Claims | null {
  try {
    const exp = url.searchParams.get('exp') || '', ticket = url.searchParams.get('ticket') || '', sig = url.searchParams.get('sig') || '';
    if (!/^\d{10}$/.test(exp) || !/^[a-zA-Z0-9_-]{60,12000}$/.test(ticket) || !/^[a-zA-Z0-9_-]{43}$/.test(sig)
      || ['exp', 'ticket', 'sig'].some(key => url.searchParams.getAll(key).length !== 1)
      || Array.from(url.searchParams.keys()).some(key => !['exp', 'ticket', 'sig'].includes(key))) return null;
    const expected = signature(url.pathname, exp, ticket);
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const packed = Buffer.from(ticket, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    decipher.setAAD(Buffer.from(url.pathname));
    const claim: Claims = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (claim.v !== 1 || claim.exp !== Number(exp) || claim.exp <= seconds || !claim.ref || !claim.location
      || !['uploads', 'videos', 'display', 'hd', 'supplier'].includes(claim.location.root)
      || !safeMediaRelative(claim.location.relative) || typeof claim.version !== 'string'
      || typeof claim.mime !== 'string' || !mediaMimeAllowed(claim.mime)
      || typeof claim.name !== 'string' || claim.name.length > 500
      || url.pathname !== `/m/${encodeURIComponent(claim.ref.type)}/${encodeURIComponent(claim.ref.id)}/${encodeURIComponent(claim.variant)}`) return null;
    if (claim.audience === 'user') {
      if (!userId || claim.userId !== userId || claim.exp > seconds + USER_MEDIA_TTL_SECONDS || claim.location.root === 'supplier') return null;
    } else if (claim.audience !== 'supplier' || claim.userId !== null || claim.ref.type !== 'supplier'
      || claim.variant !== 'original' || claim.location.root !== 'supplier' || claim.exp > seconds + SUPPLIER_MEDIA_TTL_SECONDS) return null;
    return claim;
  } catch { return null; }
}

export async function signedMediaResponse(request: Request, userId: string | null) {
  const claim = verifyMediaTicket(new URL(request.url), userId);
  if (!claim) return mediaDenied();
  if (!['GET', 'HEAD'].includes(request.method)) return mediaDenied(405);
  let file: Awaited<ReturnType<typeof checkedMediaFile>>;
  try { file = await checkedMediaFile(claim.location); } catch { return mediaDenied(404); }
  if (file.version !== claim.version) return mediaDenied(409);
  const range = request.headers.get('range');
  if (range && (range.length > 80 || !/^bytes=(\d*)-(\d*)$/.test(range))) return mediaDenied(416);
  const remaining = Math.max(0, claim.exp - Math.floor(Date.now() / 1000));
  const headers = new Headers({ ...errorHeaders,
    'Cache-Control': claim.audience === 'supplier' ? 'private, no-store' : `private, max-age=${Math.min(600, remaining)}`,
    'Content-Type': claim.mime, 'Accept-Ranges': 'bytes',
    'Content-Disposition': claim.variant === 'download' || claim.variant === 'hd-download'
      ? `attachment; filename*=UTF-8''${encodeURIComponent(claim.name.replace(/[\r\n]/g, '')).replace(/'/g, '%27')}` : 'inline',
  });
  const etag = imageStatEtag(file.stat, `media-ticket-v1:${claim.ref.type}:${claim.ref.id}:${claim.variant}:${claim.userId || 'supplier'}`);
  headers.set('ETag', etag);
  if (claim.sourceVersion) headers.set('X-Image-Source-Version', claim.sourceVersion);
  if (claim.comparisonVersion) headers.set('X-Image-Comparison-Version', claim.comparisonVersion);
  if (claim.representationVersion) headers.set('X-Image-Representation-Version', claim.representationVersion);
  if (!range && imageEtagMatches(request.headers.get('if-none-match'), etag)) {
    headers.delete('X-Accel-Redirect');
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(file.stat.size));
    return new Response(null, { status: 200, headers });
  }
  try { headers.set('X-Accel-Redirect', mediaInternalUri(await mediaDeliveryFile(claim.location, claim.version))); }
  catch (error) { return mediaDenied((error as { status?: number }).status === 409 ? 409 : 503); }
  // Nginx serves the exact immutable file, including Range/If-Range and HEAD.
  // The Node body must remain empty; resource authorization happened at issue time.
  return new Response(null, { status: 200, headers });
}
