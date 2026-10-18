import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { resolveContent } from '@/lib/content-reactions/content';
import type { ContentKey } from '@/lib/content-reactions/types';
import { originalImageInputUrl } from '@/lib/assets/original-image-input';
import { attachAssetToSiteReferenceImage } from '@/lib/assets/reference-import';
import { authorizedImageResponse } from '@/lib/media/authorized-image-response';
import { readStudioImage } from '@/lib/image-studio/media';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';
import { proxyCutout, cutoutBusinessCredential } from '@/lib/cutout/proxy';
import { isCutoutJob, isRecord } from '@/lib/cutout/receipt';
import { normalizeCutoutSettings } from '@/lib/cutout/settings';
import type { CutoutAsset, CutoutCapabilities, CutoutJob, CutoutSettings } from '@/lib/cutout/types';
import type { CutoutImageHandoff, ImageResultNextIntent, ImageResultNextReceipt } from './types';

const PREFIX = 'image_result_next_v1:';
const PRICE_MESSAGE = '当前抠图服务没有提供可核实费用。图片可先带入，开始处理前需明确确认；不会自动提交。';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Stored = {
  version: 1; receiptId: string; ownerId: string; sourceKey: ContentKey; sourceVersion: string;
  intent: ImageResultNextIntent; returnPath: string; createdAt: number; phaseAt: number;
  stage: CutoutImageHandoff['stage']; asset: CutoutAsset | null; job: CutoutJob | null;
  settings?: CutoutSettings; message: string; workspaceTabId?: string;
};
export class ImageResultNextError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function validImageResultSource(input: unknown): ContentKey {
  if (typeof input !== 'string' || !/^asset:[a-zA-Z0-9_-]{1,128}$/.test(input)) throw new ImageResultNextError('这张图片没有可用的原件记录，请从生成结果重新打开');
  return input as ContentKey;
}
export function safeImageResultReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1800 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) throw new ImageResultNextError('来源页面无效，请从生成结果重新打开');
  const url = new URL(value, 'https://sd2.youdooart.com');
  if (!['/image-studio', '/template-studio', '/story-studio'].includes(url.pathname)) throw new ImageResultNextError('此页面暂不支持图片接续，请从生图结果进入');
  return `${url.pathname}${url.search}${url.hash}`;
}
function receiptId(user: SessionUser, source: ContentKey, intent: ImageResultNextIntent) { return sha(JSON.stringify([user.id, source, intent])); }
function settingKey(id: string) { if (!/^[a-f0-9]{64}$/.test(id)) throw new ImageResultNextError('导入记录无效'); return PREFIX + id; }
async function authorizedSource(user: SessionUser, sourceKey: ContentKey) {
  if (user.account_type !== 'internal') throw new ImageResultNextError('当前账户不能使用这个创作入口', 403);
  const id = validImageResultSource(sourceKey).slice(6);
  const [asset, successfulTask, resolved] = await Promise.all([
    prisma.asset.findUnique({ where: { id } }),
    prisma.imageStudioTask.findFirst({ where: { asset_id: id, AND: [studioOutputTaskWhere], deleted_at: null }, select: { id: true, status: true, usage_json: true, asset_id: true } }),
    resolveContent(user, sourceKey),
  ]);
  if (!asset || asset.type !== 'image' || asset.status !== 'active' || !successfulTask || !studioTaskHasViewableOutput(successfulTask) || !resolved?.source || !resolved.summary.downloadUrl || resolved.source.canPreviewOriginal === false || !resolved.summary.reuse) {
    throw new ImageResultNextError('这张生成图已失效或只有预览权限，不能带入原件；原现场保留', 403);
  }
  const original = await originalImageInputUrl(user, `/api/image-studio/assets/${id}`);
  if (!original || original !== resolved.source.url && asset.original_url !== resolved.source.url) throw new ImageResultNextError('原件记录已变化，请重新打开这张结果', 409);
  return { asset, original, version: sha(JSON.stringify([asset.id, asset.original_url, asset.hash, asset.file_size, asset.width, asset.height, asset.created_at])) };
}
async function readStored(user: SessionUser, id: string) {
  const key = settingKey(id);
  const row = await prisma.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  if (!row) throw new ImageResultNextError('没有找到这次导入，请返回原结果重新打开', 404);
  let record: Stored;
  try { record = JSON.parse(row.value_json); } catch { throw new ImageResultNextError('导入记录暂不可读，原任务保留', 409); }
  if (record.version !== 1 || record.receiptId !== id || record.ownerId !== user.id || !['cutout', 'video'].includes(record.intent)) throw new ImageResultNextError('无权打开这次导入', 403);
  const source = await authorizedSource(user, record.sourceKey);
  if (source.version !== record.sourceVersion) throw new ImageResultNextError('原图片记录已改变，未使用其他图片替代，请返回原结果', 409);
  if (record.intent === 'cutout' && (user.role !== 'admin' || !cutoutBusinessCredential(process.env, user.id))) throw new ImageResultNextError('当前账户没有抠图业务授权，请联系管理员；没有提交任务', 403);
  if (record.intent === 'video' && record.stage === 'accepted') {
    const workspace = await prisma.workspace.findUnique({ where: { id: `image_next_${id}` }, select: { owner_id: true, status: true, name: true } });
    if (!workspace || workspace.owner_id !== user.id || workspace.status !== 'active' || workspace.name !== `默认工作台:${record.workspaceTabId}`) throw new ImageResultNextError('原独立视频草稿已不可用，未创建空白草稿或覆盖其他内容', 409);
  }
  return { record, raw: row.value_json, key, source };
}
function publicReceipt(record: Stored, asset: Awaited<ReturnType<typeof authorizedSource>>['asset']): ImageResultNextReceipt {
  return { receiptId: record.receiptId, intent: record.intent, sourceKey: record.sourceKey,
    source: { label: '生成图片', originalUrl: `/api/image-result-next/${record.receiptId}/original`, fileName: asset.file_name,
      ...(asset.width ? { width: asset.width } : {}), ...(asset.height ? { height: asset.height } : {}) },
    returnPath: record.returnPath,
    destination: record.intent === 'cutout' ? `/cutout?handoff=${record.receiptId}` : `/generate?image_result_handoff=${record.receiptId}`,
    message: record.message, ready: record.intent === 'cutout' || record.stage === 'accepted', ...(record.workspaceTabId ? { workspaceTabId: record.workspaceTabId } : {}) };
}
async function replace(key: string, raw: string, record: Stored) {
  return (await prisma.platformSetting.updateMany({ where: { key, value_json: raw }, data: { value_json: JSON.stringify(record), updated_by: record.ownerId } })).count === 1;
}
export async function createImageResultNext(user: SessionUser, sourceKey: ContentKey, intent: ImageResultNextIntent, returnPath: string) {
  const source = await authorizedSource(user, sourceKey);
  if (intent === 'cutout' && (user.role !== 'admin' || !cutoutBusinessCredential(process.env, user.id))) throw new ImageResultNextError('当前账户没有抠图业务授权，请联系管理员；没有提交任务', 403);
  const id = receiptId(user, sourceKey, intent), key = settingKey(id);
  const now = Date.now();
  const record: Stored = { version: 1, receiptId: id, ownerId: user.id, sourceKey, sourceVersion: source.version, intent, returnPath,
    createdAt: now, phaseAt: now, stage: 'import-ready', asset: null, job: null,
    message: intent === 'cutout' ? PRICE_MESSAGE : '正在准备独立视频草稿；不会生成视频。',
    ...(intent === 'video' ? { workspaceTabId: `image-next-${id.slice(0, 48)}` } : {}) };
  await prisma.platformSetting.upsert({ where: { key }, update: {}, create: { key, value_json: JSON.stringify(record), updated_by: user.id } });
  if (intent === 'video') await prepareVideoWorkspace(user, id);
  return getImageResultNext(user, id);
}
export async function findImageResultNext(user: SessionUser, source: ContentKey, intent: ImageResultNextIntent) {
  const id = receiptId(user, source, intent);
  const found = await prisma.platformSetting.findUnique({ where: { key: settingKey(id) }, select: { id: true } });
  return found ? getImageResultNext(user, id) : null;
}
export async function getImageResultNext(user: SessionUser, id: string) {
  const { record, source } = await readStored(user, id);
  return publicReceipt(record, source.asset);
}
export async function imageResultOriginal(request: Request, user: SessionUser, id: string) {
  const { source } = await readStored(user, id);
  return authorizedImageResponse(request, source.original, 'original', source.asset.mime_type, source.asset.file_name);
}
export async function prepareVideoWorkspace(user: SessionUser, id: string) {
  const { record, raw, key, source } = await readStored(user, id);
  if (record.intent !== 'video' || !record.workspaceTabId) throw new ImageResultNextError('导入目标无效');
  if (record.stage === 'accepted') return;
  // Deterministic ids and one transaction protect initialization from parallel tabs.
  await prisma.$transaction(async db => {
    const latest = await db.platformSetting.findUnique({ where: { key } });
    if (!latest || latest.value_json !== raw) return;
    const workspaceId = `image_next_${id}`;
    const existing = await db.workspace.findUnique({ where: { id: workspaceId } });
    if (existing && (existing.owner_id !== user.id || existing.status !== 'active')) throw new ImageResultNextError('原独立视频草稿不可用，未覆盖其他草稿', 409);
    if (!existing) await db.workspace.create({ data: { id: workspaceId, owner_id: user.id, name: `默认工作台:${record.workspaceTabId}` } });
    await attachAssetToSiteReferenceImage({ user, workspaceId, sourceRequestId: id, sourceLabel: '生成图片继续创作', role: 'first_frame',
      albumName: '生成工作台参考图', albumDescription: '生成图片导入视频首帧', metadataSource: 'image_result_next', allowSharedAsset: true, db }, source.asset.id);
    await db.platformSetting.updateMany({ where: { key, value_json: raw }, data: { value_json: JSON.stringify({ ...record, stage: 'accepted', message: '图片已带入首帧，填写想让画面怎么动；点击生成后才会创建视频。' }), updated_by: user.id } });
  });
}
async function cutoutCall(request: Request, user: SessionUser, path: string[], method = 'GET', body?: BodyInit, headers?: Record<string, string>) {
  const origin = new URL(request.url).origin;
  return proxyCutout(new Request(`${origin}/api/cutout/${path.join('/')}`, { method,
    headers: { Origin: origin, Host: new URL(request.url).host, ...headers }, ...(body ? { body } : {}) }), path, user);
}
function cutoutDTO(record: Stored, asset: Awaited<ReturnType<typeof authorizedSource>>['asset']): CutoutImageHandoff {
  const interrupted = ['preparing', 'submitting'].includes(record.stage) && Date.now() - record.phaseAt > 120_000;
  return { ...publicReceipt(record, asset), stage: interrupted ? 'unknown' : record.stage, asset: record.asset, job: record.job,
    ...(record.settings ? { settings: record.settings } : {}), autoStart: { allowed: false, message: PRICE_MESSAGE },
    message: interrupted ? '原导入或提交的结果尚未确认。请查询原记录或任务历史，不要重新提交。' : record.message };
}
export async function getCutoutImageHandoff(request: Request, user: SessionUser, id: string): Promise<CutoutImageHandoff> {
  const { record, source } = await readStored(user, id);
  if (record.intent !== 'cutout') throw new ImageResultNextError('这次导入不是抠图记录');
  if (record.job) {
    const response = await cutoutCall(request, user, ['v1', 'jobs', record.job.job_id]);
    const body: unknown = await response.json().catch(() => null);
    if (response.ok && isCutoutJob(body, { id: record.job.job_id, kind: 'cutout' })) return cutoutDTO({ ...record, job: body }, source.asset);
    return cutoutDTO({ ...record, message: '原任务暂未读到最新状态，已受理记录保留，请稍后查询。' }, source.asset);
  }
  return cutoutDTO(record, source.asset);
}
export async function prepareCutoutImageHandoff(request: Request, user: SessionUser, id: string) {
  const { record, raw, key, source } = await readStored(user, id);
  if (record.intent !== 'cutout') throw new ImageResultNextError('导入目标无效');
  if (record.stage !== 'import-ready') return getCutoutImageHandoff(request, user, id);
  const capabilitiesResponse = await cutoutCall(request, user, ['v1', 'capabilities']);
  const capabilities = await capabilitiesResponse.json().catch(() => null) as CutoutCapabilities | null;
  if (!capabilitiesResponse.ok || !capabilities?.integration?.ready) throw new ImageResultNextError(capabilities?.integration?.message || '抠图服务暂不可用，原图保留', 503);
  let bytes: Buffer;
  try { bytes = await readStudioImage(source.original, AbortSignal.timeout(45_000)); }
  catch { throw new ImageResultNextError('原图暂时无法读取，尚未传入抠图或提交任务；请保留原结果稍后重试', 503); }
  const maxMb = capabilities.limits?.max_upload_mb;
  if (typeof maxMb === 'number' && Number.isFinite(maxMb) && bytes.length > maxMb * 1024 * 1024) throw new ImageResultNextError('这张原图超过抠图上传限制，请手动选择可用图片；未压缩或替换原图');
  const preparing: Stored = { ...record, stage: 'preparing', phaseAt: Date.now(), message: '正在传输原图；不会创建抠图任务。' };
  if (!await replace(key, raw, preparing)) return getCutoutImageHandoff(request, user, id);
  try {
    const data = new FormData(); data.append('file', new Blob([new Uint8Array(bytes)], { type: source.asset.mime_type }), source.asset.file_name);
    const response = await cutoutCall(request, user, ['v1', 'assets'], 'POST', data);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body) || typeof body.asset_id !== 'string' || !/^[\w-]{1,128}$/.test(body.asset_id)
      || ![body.width, body.height, body.size].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      await replace(key, JSON.stringify(preparing), { ...preparing, stage: 'unknown', message: '原图传输结果尚未确认，未提交抠图。保留此次导入，不自动再次上传。' });
    } else {
      const asset: CutoutAsset = { asset_id: body.asset_id, name: typeof body.name === 'string' ? body.name : source.asset.file_name,
        width: body.width as number, height: body.height as number, size: body.size as number };
      await replace(key, JSON.stringify(preparing), { ...preparing, asset, stage: 'awaiting-confirmation', message: PRICE_MESSAGE });
    }
  } catch {
    await replace(key, JSON.stringify(preparing), { ...preparing, stage: 'unknown', message: '原图传输结果尚未确认，未提交抠图。请保留此次导入，不要再次上传。' });
  }
  return getCutoutImageHandoff(request, user, id);
}
function checkedCutoutSettings(value: unknown): CutoutSettings {
  if (!isRecord(value)) throw new ImageResultNextError('普通抠图参数不完整，请重新确认；尚未提交任务');
  const normalized = normalizeCutoutSettings(value);
  if (Object.entries(normalized).some(([key, expected]) => value[key] !== expected)
    || Object.keys(value).some(key => !Object.hasOwn(normalized, key))) {
    throw new ImageResultNextError('普通抠图参数无效或版本已变化，请重新确认；没有用默认参数替代或提交任务');
  }
  return value as unknown as CutoutSettings;
}
export async function startCutoutImageHandoff(request: Request, user: SessionUser, id: string, settingsInput: unknown, confirmUnknownPrice: boolean) {
  const { record, raw, key } = await readStored(user, id);
  if (record.intent !== 'cutout') throw new ImageResultNextError('导入目标无效');
  if (!['awaiting-confirmation', 'not-submitted'].includes(record.stage) || !record.asset) return getCutoutImageHandoff(request, user, id);
  if (!confirmUnknownPrice) throw new ImageResultNextError(PRICE_MESSAGE, 409);
  const requestedSettings = checkedCutoutSettings(settingsInput);
  const settings = record.settings ? checkedCutoutSettings(record.settings) : requestedSettings;
  if (record.settings && Array.from(new Set([...Object.keys(settings), ...Object.keys(requestedSettings)]))
    .some(key => settings[key as keyof CutoutSettings] !== requestedSettings[key as keyof CutoutSettings])) {
    throw new ImageResultNextError('原抠图参数已冻结，本次设置与原参数不同，尚未提交任务。请恢复原参数后重试同一次处理。', 409);
  }
  const capsResponse = await cutoutCall(request, user, ['v1', 'capabilities']);
  const caps = await capsResponse.json().catch(() => null) as CutoutCapabilities | null;
  if (!capsResponse.ok || !caps?.integration?.ready) throw new ImageResultNextError(caps?.integration?.message || '抠图服务暂不可用，尚未提交', 503);
  if (settings.model_preference !== 'auto' && !caps.models?.some(model => model.id === settings.model_preference && model.available)) throw new ImageResultNextError('所选普通抠图模型暂不可用，请选择可用模型后确认；没有换用其他模型', 409);
  const submitting: Stored = { ...record, settings, stage: 'submitting', phaseAt: Date.now(), message: '正在确认这次普通抠图提交。' };
  if (!await replace(key, raw, submitting)) return getCutoutImageHandoff(request, user, id);
  try {
    const response = await cutoutCall(request, user, ['v1', 'jobs'], 'POST', JSON.stringify({ asset_id: record.asset.asset_id, kind: 'cutout', parameters: { settings } }),
      { 'Content-Type': 'application/json', 'Idempotency-Key': `image-next-${id}` });
    const body: unknown = await response.json().catch(() => null);
    const success = response.ok && isCutoutJob(body, { kind: 'cutout' });
    const definitelyNotSubmitted = !response.ok && isRecord(body) && body.submission_made === false;
    await replace(key, JSON.stringify(submitting), { ...submitting, stage: success ? 'accepted' : definitelyNotSubmitted ? 'not-submitted' : 'unknown',
      job: success ? body as CutoutJob : null, message: success ? '普通抠图已受理，可查询原任务；离开页面不会取消。'
        : definitelyNotSubmitted ? '服务确认没有提交任务，原图和参数保留，可明确重试同一次处理。' : '无法确认原任务是否已受理。请查询历史并保留此次记录，不要重新提交。' });
  } catch {
    await replace(key, JSON.stringify(submitting), { ...submitting, stage: 'unknown', message: '无法确认原任务是否已受理。请查询历史并保留此次记录，不要重新提交。' });
  }
  return getCutoutImageHandoff(request, user, id);
}
