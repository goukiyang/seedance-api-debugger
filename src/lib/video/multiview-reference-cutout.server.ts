import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, stat, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { proxyCutout, cutoutBusinessCredential } from '@/lib/cutout/proxy';
import { isCutoutJob, isRecord } from '@/lib/cutout/receipt';
import { cutoutResultContent } from '@/lib/cutout/result-content';
import { normalizeCutoutSettings } from '@/lib/cutout/settings';
import type { CutoutAsset, CutoutCapabilities, CutoutJob, CutoutSettings } from '@/lib/cutout/types';
import { recordUsageAttribution } from '@/lib/admin/usage-attribution';
import { getMultiviewWork, currentMultiviewActor, MultiviewWorkError } from './multiview-works';
import { MULTIVIEW_ACTION_ENABLED } from './multiview-action-capability';
import { multiviewFrame } from './multiview';
import type { MultiviewInfo, MultiviewSlot } from './multiview-contract';
import type { ReferenceForeground } from './multiview-reference-layout';

const PREFIX = 'multiview_reference_cutout_v1:';
export const MULTIVIEW_CUTOUT_PRICE_MESSAGE = '抠图服务尚未提供可核实费用。确认后开始本张处理；不会自动处理其他图片。';
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const identity = (ownerId: string, taskId: string, version: string, frame: number) => sha(JSON.stringify([ownerId, taskId, version, frame]));
type Stored = { schema: 1; ownerId: string; taskId: string; sourceVersion: string; frame: number; receiptId: string;
  stage: 'import-ready' | 'preparing' | 'awaiting-confirmation' | 'submitting' | 'accepted' | 'not-submitted' | 'unknown' | 'ready';
  phaseAt: number; asset: CutoutAsset | null; job: CutoutJob | null; settings?: CutoutSettings;
  sha256?: string; resultUrl?: string; message: string };
const fail = (message: string, status = 409) => new MultiviewWorkError(message, status, 'REFERENCE_BACKGROUND_NOT_READY', { notCommitted: true });
async function call(request: Request, user: SessionUser, parts: string[], method = 'GET', body?: BodyInit, extra?: Record<string, string>) {
  const origin = new URL(request.url).origin;
  return proxyCutout(new Request(`${origin}/api/cutout/${parts.join('/')}`, { method,
    headers: { Origin: origin, Host: new URL(request.url).host, ...extra }, ...(body ? { body } : {}) }), parts, user);
}
async function authorized(user: SessionUser, workId: string, slotId: string) {
  await currentMultiviewActor(user);
  const work = await getMultiviewWork(user, workId);
  if (work.removed || work.sourceState !== 'current' || work.recipe?.schema !== 3 || !work.info) throw fail('参考拼图来源已变化，原输入与已有结果保留。');
  const slot = work.recipe.slots.find(item => item.id === slotId);
  if (!slot) throw fail('这张图片已不在当前拼图中。', 400);
  const receiptId = identity(user.id, work.sourceTaskId, work.recipe.sourceVersion, slot.frame), key = PREFIX + receiptId;
  return { work, slot, receiptId, key };
}
async function stored(key: string): Promise<{ raw: string; value: Stored } | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  if (!row) return null;
  let value: Stored;
  try { value = JSON.parse(row.value_json); } catch { throw fail('原背景处理记录暂不可读取，请保留原任务编号。', 503); }
  if (value.schema !== 1 || key !== PREFIX + identity(value.ownerId, value.taskId, value.sourceVersion, value.frame)) throw fail('原背景处理记录身份不一致。', 503);
  return { raw: row.value_json, value };
}
async function replace(key: string, raw: string, value: Stored) {
  return (await prisma.platformSetting.updateMany({ where: { key, value_json: raw }, data: { value_json: JSON.stringify(value), updated_by: value.ownerId } })).count === 1;
}
async function directory(ownerId: string) {
  const root = process.env.NODE_ENV === 'production' ? '/data/video-api-debugger/var-lib/storage/multiview-reference-foregrounds' : path.join(process.cwd(), '.cache', 'multiview-reference-foregrounds');
  if (process.env.NODE_ENV === 'production') {
    const [data, system] = await Promise.all([lstat('/data'), stat('/')]);
    if (!data.isDirectory() || data.isSymbolicLink() || data.dev === system.dev) throw fail('数据盘暂不可用，原图保留。', 503);
  }
  const target = path.join(root, sha(ownerId));
  let current = path.parse(target).root;
  for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(current) !== current
      || (current === root || current === target) && (Boolean(entry.mode & 0o077) || typeof process.getuid === 'function' && entry.uid !== process.getuid())) throw fail('前景存储位置校验失败。', 503);
  }
  return target;
}
async function readForegroundFile(ownerId: string, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw fail('前景文件标识无效。', 400);
  const file = path.join(await directory(ownerId), `${hash}.png`), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024 ** 2 || before.mode & 0o077 || typeof process.getuid === 'function' && before.uid !== process.getuid()) throw fail('前景文件不可安全读取。', 503);
    const bytes = await handle.readFile(), after = await handle.stat();
    if (sha(bytes) !== hash || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail('前景文件已变化。', 503);
    return bytes;
  } finally { await handle.close(); }
}
async function publishForeground(ownerId: string, bytes: Buffer, info: MultiviewInfo) {
  const metadata = await sharp(bytes, { limitInputPixels: 16777216 }).metadata();
  if (metadata.format !== 'png' || !metadata.hasAlpha || metadata.width !== info.width || metadata.height !== info.height) throw fail('处理结果未保留透明通道或原尺寸，原图与拼图布局保留。');
  const alpha = await sharp(bytes).ensureAlpha().extractChannel(3).stats();
  if (alpha.channels[0].min === 255 || alpha.channels[0].max === 0) throw fail('处理结果仍为不透明背景，尚不能作为统一底色前景。');
  const hash = sha(bytes), root = await directory(ownerId), file = path.join(root, `${hash}.png`), temporary = path.join(root, `.prepare-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, file).catch(error => { if (error.code !== 'EEXIST') throw error; }); }
  finally { await unlink(temporary).catch(() => undefined); }
  await readForegroundFile(ownerId, hash);
  return hash;
}
function dto(value: Stored, slotId: string) {
  const interrupted = ['preparing', 'submitting'].includes(value.stage) && Date.now() - value.phaseAt > 120000;
  return { receiptId: value.receiptId, slotId, stage: interrupted ? 'unknown' : value.stage, asset: value.asset, job: value.job,
    settings: value.settings, message: interrupted ? '原处理结果待确认，请查询原记录；不会自动重新提交。' : value.message,
    priceMessage: MULTIVIEW_CUTOUT_PRICE_MESSAGE, resultUrl: value.resultUrl || null,
    foreground: value.stage === 'ready' && value.asset && value.job && value.sha256 ? { slotId, jobId: value.job.job_id, sourceAssetId: value.asset.asset_id, sha256: value.sha256 } satisfies ReferenceForeground : null };
}
export async function getMultiviewReferenceCutout(request: Request, user: SessionUser, workId: string, slotId: string) {
  const { work, receiptId, key } = await authorized(user, workId, slotId);
  const original = await stored(key);
  if (!original) return { receiptId, slotId, stage: 'import-ready', asset: null, job: null, foreground: null, resultUrl: null, message: '背景待处理', priceMessage: MULTIVIEW_CUTOUT_PRICE_MESSAGE };
  let { value, raw } = original;
  if (value.ownerId !== user.id) throw fail('无权读取背景处理记录。', 403);
  if (value.job && value.stage !== 'ready') {
    const response = await call(request, user, ['v1', 'jobs', value.job.job_id]);
    const job: unknown = await response.json().catch(() => null);
    if (response.ok && isCutoutJob(job, { id: value.job.job_id, kind: 'cutout' })) {
      const next = { ...value, job };
      const content = cutoutResultContent(job, 'result');
      if (content && work.info) {
        const parts = content.url.split('/').slice(-2).map(decodeURIComponent), output = await call(request, user, ['v1', 'results', ...parts]);
        if (!output.ok || Number(output.headers.get('content-length')) > 128 * 1024 ** 2) throw fail('透明前景尚未读取完成，原任务保留。', 503);
        const chunks: Uint8Array[] = []; let size = 0;
        if (!output.body) throw fail('透明前景为空，原任务保留。', 503);
        const reader = output.body.getReader();
        try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 128 * 1024 ** 2) throw fail('透明前景超过可处理大小。'); chunks.push(item.value); } }
        finally { await reader.cancel().catch(() => undefined); }
        const hash = await publishForeground(user.id, Buffer.concat(chunks), work.info);
        Object.assign(next, { stage: 'ready', sha256: hash, resultUrl: content.url, message: '透明前景已就绪' });
      }
      if (await replace(key, raw, next)) value = next;
    }
  }
  return dto(value, slotId);
}
export async function mutateMultiviewReferenceCutout(request: Request, user: SessionUser, workId: string, slotId: string, input: Record<string, unknown>) {
  if (!MULTIVIEW_ACTION_ENABLED || process.env.MULTIVIEW_REFERENCE_READ_ONLY === '1') throw fail('当前仅可读取原背景处理记录。', 503);
  const { work, slot, receiptId, key } = await authorized(user, workId, slotId);
  if (user.role !== 'admin' || !cutoutBusinessCredential(process.env, user.id)) throw fail('当前账号没有既有抠图授权，原图仍可查看和导出。', 403);
  if (Object.keys(input).some(name => !['action', 'settings', 'confirmUnknownPrice'].includes(name)) || !['prepare', 'start'].includes(String(input.action))) throw fail('背景处理操作无效。', 400);
  let original = await stored(key);
  if (!original) {
    const initial: Stored = { schema: 1, receiptId, ownerId: user.id, taskId: work.sourceTaskId, sourceVersion: work.sourceVersion!, frame: slot.frame,
      stage: 'import-ready', phaseAt: Date.now(), asset: null, job: null, message: '背景待处理' };
    await prisma.platformSetting.upsert({ where: { key }, create: { key, updated_by: user.id, value_json: JSON.stringify(initial) }, update: {} });
    original = (await stored(key))!;
  }
  const { raw, value } = original;
  const capsResponse = await call(request, user, ['v1', 'capabilities']);
  const capabilities = await capsResponse.json().catch(() => null) as CutoutCapabilities | null;
  if (!capsResponse.ok || !capabilities?.integration?.ready) throw fail(capabilities?.integration?.message || '抠图服务暂不可用，原图保留。', 503);
  if (input.action === 'prepare' && value.stage === 'import-ready') {
    const bytes = await multiviewFrame(user, work.sourceTaskId, request, work.sourceVersion!, slot.frame, work.sourceId ? { kind: 'work', id: work.id } : undefined);
    const preparing: Stored = { ...value, stage: 'preparing', phaseAt: Date.now(), message: '正在带入本张原帧' };
    if (await replace(key, raw, preparing)) {
      try {
        const form = new FormData(); form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), `multiview-frame-${slot.frame}.png`);
        const response = await call(request, user, ['v1', 'assets'], 'POST', form), body: unknown = await response.json().catch(() => null);
        const valid = response.ok && isRecord(body) && typeof body.asset_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(body.asset_id)
          && body.width === work.info!.width && body.height === work.info!.height && typeof body.size === 'number' && Number.isSafeInteger(body.size) && body.size > 0 && body.size <= 128 * 1024 ** 2;
        const next: Stored = valid ? { ...preparing, stage: 'awaiting-confirmation', asset: body as unknown as CutoutAsset, message: MULTIVIEW_CUTOUT_PRICE_MESSAGE }
          : { ...preparing, stage: 'unknown', message: '原帧带入结果待确认，没有自动再次上传或提交抠图。' };
        await replace(key, JSON.stringify(preparing), next);
      } catch { await replace(key, JSON.stringify(preparing), { ...preparing, stage: 'unknown', message: '原帧带入结果待确认，请保留原记录。' }); }
    }
  } else if (input.action === 'start' && ['awaiting-confirmation', 'not-submitted'].includes(value.stage) && value.asset) {
    if (input.confirmUnknownPrice !== true) throw fail(MULTIVIEW_CUTOUT_PRICE_MESSAGE);
    if (!isRecord(input.settings)) throw fail('请确认本张抠图设置，尚未提交。', 400);
    const normalized = normalizeCutoutSettings(input.settings);
    if (Object.keys(input.settings).length !== Object.keys(normalized).length || Object.entries(normalized).some(([name, expected]) => input.settings && (input.settings as Record<string, unknown>)[name] !== expected)) throw fail('抠图设置无效，没有替换参数或提交任务。', 400);
    const settings = normalized as CutoutSettings;
    if (value.settings && JSON.stringify(value.settings) !== JSON.stringify(settings)) throw fail('原任务设置已冻结，请恢复原参数后查询同一次处理。');
    if (settings.model_preference !== 'auto' && !capabilities.models?.some(model => model.id === settings.model_preference && model.available)) throw fail('所选抠图模型暂不可用，没有替换型号。');
    const submitting: Stored = { ...value, settings, stage: 'submitting', phaseAt: Date.now(), message: '正在确认本张处理' };
    const claimed = await prisma.$transaction(async db => {
      if ((await db.platformSetting.updateMany({ where: { key, value_json: raw }, data: { value_json: JSON.stringify(submitting), updated_by: user.id } })).count !== 1) return false;
      const prior = await db.$queryRaw<Array<{ source_id: string }>>`SELECT source_id FROM UsageAttribution WHERE source_kind = 'cutout_receipt' AND source_id = ${receiptId}`;
      if (!prior.length) await recordUsageAttribution(db, { sourceKind: 'cutout_receipt', sourceId: receiptId, actorUserId: user.id, ownerUserId: user.id,
        projectId: work.projectId, occurredAt: new Date(submitting.phaseAt), contextOrigin: 'cutout-local-submission' });
      return true;
    });
    if (claimed) {
      const response = await call(request, user, ['v1', 'jobs'], 'POST', JSON.stringify({ asset_id: value.asset.asset_id, kind: 'cutout', parameters: { settings } }), { 'Content-Type': 'application/json', 'Idempotency-Key': `mv-reference-${receiptId}` });
      const body: unknown = await response.json().catch(() => null), success = response.ok && isCutoutJob(body, { kind: 'cutout' });
      await replace(key, JSON.stringify(submitting), { ...submitting, stage: success ? 'accepted' : !response.ok && isRecord(body) && body.submission_made === false ? 'not-submitted' : 'unknown',
        job: success ? body as CutoutJob : null, message: success ? '本张抠图已受理' : '原处理结果待确认，请查询原记录。' });
    }
  }
  return getMultiviewReferenceCutout(request, user, workId, slotId);
}
export async function readMultiviewReferenceForeground(user: SessionUser, taskId: string, info: MultiviewInfo, slot: MultiviewSlot, foreground: ReferenceForeground) {
  const record = await stored(PREFIX + identity(user.id, taskId, info.sourceVersion, slot.frame));
  const value = record?.value;
  if (!value || value.ownerId !== user.id || value.stage !== 'ready' || value.job?.job_id !== foreground.jobId || value.asset?.asset_id !== foreground.sourceAssetId || value.sha256 !== foreground.sha256) throw fail('透明前景与原帧的关系无法确认，未回退异色原图。');
  const bytes = await readForegroundFile(user.id, foreground.sha256);
  const metadata = await sharp(bytes, { limitInputPixels: 16777216 }).metadata();
  if (!metadata.hasAlpha || metadata.width !== info.width || metadata.height !== info.height) throw fail('透明前景已失效，原配方保留。');
  return bytes;
}
