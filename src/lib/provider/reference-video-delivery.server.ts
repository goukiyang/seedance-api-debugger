import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type { CreateVideoInput } from '@/types';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { resolveSitePublicBaseUrl, siteUploadBaseUrls, siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { canUseDirectAsset, assertCanUseReferenceImage } from '@/lib/reference-albums/permissions';
import { PROVIDER_REFERENCE_MEDIA_ISSUANCE_ENABLED } from './reference-video-delivery-build-mode';
import { mediaPreviewResponse } from '@/lib/media/preview-response';

export const REFERENCE_VIDEO_DELIVERY_VERSION = 'local-video-v1';
export type ReferenceVideoFamily = 'ordinary' | 'ip';
export type AuthorizedLocalReferenceVideo = { assetId: string; source: string; hash: string; size: number; stamp: string };
export type ReferenceVideoDelivery = { version: typeof REFERENCE_VIDEO_DELIVERY_VERSION; family: ReferenceVideoFamily;
  executionSeconds: number; sources: AuthorizedLocalReferenceVideo[] };
type Ticket = { v: 1; task: string; owner: string; asset: string; version: string; stamp: string; issued: number; expires: number };
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const unavailable = () => new Error('参考视频当前无法安全读取，尚未发送生成请求，请保留原素材后重试。');

export async function referenceVideoDeliveryEnabled(family: ReferenceVideoFamily) {
  const key = family === 'ip' ? 'PROVIDER_REFERENCE_MEDIA_IP_ENABLED' : 'PROVIDER_REFERENCE_MEDIA_ORDINARY_ENABLED';
  if (process.env.NODE_ENV !== 'production') return process.env[key] === '1';
  // Activation follows the rolling worker handoff; startup env remains stale in the running web process.
  try { return parseDotenv(await fs.readFile(path.join(process.cwd(), '.env'), 'utf8'))[key] === '1'; }
  catch { return false; }
}

export function referenceVideoExecutionSeconds(value: number | undefined) {
  if (value === undefined) return 172800;
  if (!Number.isInteger(value) || value < 3600 || value > 259200) throw new RangeError('生成执行期限必须为3600至259200秒，尚未提交。');
  return value;
}

function signingIdentity() {
  const secret = process.env.SESSION_SECRET;
  const base = resolveSitePublicBaseUrl();
  const configured = [process.env.SITE_PUBLIC_BASE_URL, process.env.BASE_URL, process.env.NEXTAUTH_URL, process.env.NEXT_PUBLIC_BASE_URL]
    .some(value => { try { return Boolean(value && new URL(value).origin === base); } catch { return false; } });
  if (!secret || secret.length < 32 || secret === 'dev-secret-change-in-production' || !base || !configured
    || new URL(base).protocol !== 'https:' || new URL(base).username || new URL(base).password) throw unavailable();
  return { base, key: createHmac('sha256', secret).update('sd2/provider-reference-video/v1').digest() };
}

function sourceVersion(source: Pick<AuthorizedLocalReferenceVideo, 'assetId' | 'source' | 'hash' | 'size'>) {
  return createHash('sha256').update(JSON.stringify([source.assetId, siteUploadPathFromUrl(source.source), source.hash, source.size])).digest('hex');
}

export async function authorizedReferenceVideoFile(source: Pick<AuthorizedLocalReferenceVideo, 'source' | 'size'>) {
  const local = siteUploadPathFromUrl(source.source);
  if (!local?.startsWith('/uploads/assets/')) throw unavailable();
  try {
    const root = await fs.realpath(path.join(process.cwd(), 'public/uploads/assets'));
    const file = await fs.realpath(path.resolve(process.cwd(), 'public', decodeURIComponent(local).replace(/^\/+/, '')));
    if (!file.startsWith(`${root}${path.sep}`)) throw unavailable();
    const info = await fs.stat(file);
    if (!info.isFile() || !info.size || info.size !== source.size) throw unavailable();
    return { file, stamp: `${info.size}:${info.mtimeMs}:${info.ctimeMs}` };
  } catch { throw unavailable(); }
}

async function assertUse(user: SessionUser, assetId: string) {
  if (await canUseDirectAsset(user, assetId)) return;
  const references = await prisma.referenceImage.findMany({ where: { asset_id: assetId, status: 'active' }, select: { id: true } });
  for (const ref of references) {
    try { await assertCanUseReferenceImage(user, ref.id); return; } catch { /* Another album may carry the actual use grant. */ }
  }
  throw unavailable();
}

// Paths always come from a registered Asset after its actual use grant is checked.
export async function authorizeLocalReferenceVideos(user: SessionUser, urls: string[]): Promise<AuthorizedLocalReferenceVideo[]> {
  const sources: AuthorizedLocalReferenceVideo[] = [];
  for (const url of urls) {
    const local = siteUploadPathFromUrl(url);
    if (!local) continue;
    if (!local.startsWith('/uploads/assets/')) throw unavailable();
    const aliases = [local, ...siteUploadBaseUrls().map(base => `${base}${local}`)];
    const assets = await prisma.asset.findMany({ where: { original_url: { in: aliases }, type: 'video', status: { not: 'deleted' } } });
    let selected: typeof assets[number] | undefined;
    for (const asset of assets) {
      try { await assertUse(user, asset.id); selected = asset; break; } catch { /* A copied row does not grant its owner's use rights. */ }
    }
    if (!selected || !/^[a-f0-9]{64}$/.test(selected.hash || '') || !Number.isSafeInteger(selected.file_size) || selected.file_size <= 0) throw unavailable();
    const source = { assetId: selected.id, source: selected.original_url, hash: selected.hash!, size: selected.file_size };
    const { stamp } = await authorizedReferenceVideoFile(source);
    sources.push({ ...source, stamp });
  }
  return sources;
}

export async function planReferenceVideoDelivery(user: SessionUser, input: CreateVideoInput, family: ReferenceVideoFamily,
  authorized?: AuthorizedLocalReferenceVideo[]): Promise<ReferenceVideoDelivery | undefined> {
  if (input.generation_mode !== 'all_in_one_reference') return;
  const sources = authorized || await authorizeLocalReferenceVideos(user, input.reference_video_urls || []);
  if (!sources.length) return;
  if (!PROVIDER_REFERENCE_MEDIA_ISSUANCE_ENABLED || !await referenceVideoDeliveryEnabled(family)) throw unavailable();
  signingIdentity();
  return { version: REFERENCE_VIDEO_DELIVERY_VERSION, family,
    executionSeconds: referenceVideoExecutionSeconds(input.execution_expires_after), sources };
}

export async function prepareReferenceVideoDelivery(taskId: string, user: SessionUser, urls: string[], delivery: ReferenceVideoDelivery, issuedAt: number) {
  const identity = signingIdentity();
  const fresh = await authorizeLocalReferenceVideos(user, urls);
  const expected = new Map(delivery.sources.map(source => [siteUploadPathFromUrl(source.source), source]));
  const byPath = new Map(fresh.map(source => [siteUploadPathFromUrl(source.source), source]));
  if (fresh.length !== delivery.sources.length || !Number.isSafeInteger(issuedAt) || issuedAt > Date.now()) throw unavailable();
  const expires = issuedAt + delivery.executionSeconds * 1000 + 300000;
  if (expires <= Date.now()) throw unavailable();
  return urls.map(url => {
    const local = siteUploadPathFromUrl(url);
    if (!local) return url;
    const source = expected.get(local), current = byPath.get(local);
    if (!source || !current || sourceVersion(source) !== sourceVersion(current) || source.stamp !== current.stamp) throw unavailable();
    const ticket: Ticket = { v: 1, task: taskId, owner: user.id, asset: source.assetId,
      version: sourceVersion(source), stamp: source.stamp, issued: issuedAt, expires };
    const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
    const signature = createHmac('sha256', identity.key).update(payload).digest('base64url');
    return `${identity.base}/api/provider/reference-media?ticket=${payload}.${signature}`;
  });
}

function readTicket(raw: string | null): Ticket | null {
  if (!raw || raw.length > 2400) return null;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', signingIdentity().key).update(payload).digest('base64url');
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Ticket;
    if (ticket.v !== 1 || !['task', 'owner', 'asset'].every(key => typeof ticket[key as 'task'] === 'string' && /^[A-Za-z0-9-]{1,120}$/.test(ticket[key as 'task']))
      || !/^[a-f0-9]{64}$/.test(ticket.version) || typeof ticket.stamp !== 'string'
      || !Number.isSafeInteger(ticket.issued) || !Number.isSafeInteger(ticket.expires) || ticket.issued > Date.now()
      || ticket.expires <= Date.now() || ticket.expires - ticket.issued > 259500000 || ticket.expires <= ticket.issued) return null;
    return ticket;
  } catch { return null; }
}

export async function providerReferenceVideoResponse(request: Request) {
  const denied = () => Response.json({ error: '参考素材读取凭证无效或素材已不可用' }, { status: 403, headers });
  const ticket = readTicket(new URL(request.url).searchParams.get('ticket'));
  if (!ticket) return denied();
  const [task, owner, asset] = await Promise.all([
    prisma.videoTask.findUnique({ where: { id: ticket.task } }), prisma.user.findUnique({ where: { id: ticket.owner } }),
    prisma.asset.findUnique({ where: { id: ticket.asset } }),
  ]);
  if (!task || !owner || !asset || (task.owner_user_id || task.user_id) !== owner.id || !['seedance', 'volcengine_ark'].includes(task.provider)
    || task.generation_mode !== 'all_in_one_reference' || owner.status !== 'active' || !['admin', 'user'].includes(owner.role)
    || !['internal', 'external'].includes(owner.account_type)
    || owner.expires_at && owner.expires_at <= new Date() || asset.type !== 'video' || asset.status === 'deleted') return denied();
  const source = { assetId: asset.id, source: asset.original_url, hash: asset.hash || '', size: asset.file_size, stamp: ticket.stamp };
  const urls = JSON.parse(task.reference_video_urls || '[]') as string[];
  if (!urls.some(url => siteUploadPathFromUrl(url) === siteUploadPathFromUrl(source.source)) || sourceVersion(source) !== ticket.version) return denied();
  const actor = { ...owner, role: owner.role as SessionUser['role'], account_type: owner.account_type as SessionUser['account_type'], status: 'active' } as SessionUser;
  try { await assertUse(actor, asset.id); } catch { return denied(); }
  if ((await authorizedReferenceVideoFile(source)).stamp !== ticket.stamp) return denied();
  return mediaPreviewResponse(request, asset.original_url, asset.mime_type);
}
