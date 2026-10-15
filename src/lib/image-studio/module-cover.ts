import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Asset } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { canManageStudioPreset, canViewStudioPreset, type ImageStudioIdentity } from './access';
import { assertStudioActor, studioSharedBinding, type SharedStudioClient } from './shared-contract';
import { studioPresetArchived } from './preset-lifecycle';
import { studioHiddenAssetUrls } from './protected-assets';
import { readStudioImage, studioTemplateAssetUrl } from './media';
import { LEGACY_MODULE_COVER_OUTPUT, MODULE_COVER_OUTPUT, type ModuleCoverDTO, type ModuleCoverEditorState, type ModuleCoverRecipe,
  type ModuleCoverRequestResult, type ModuleCoverSaveInput, type ModuleCoverSourceDTO, type ModuleCoverTarget } from './module-cover-types';

export class ModuleCoverError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const moduleCoverKey = (target: ModuleCoverTarget) => `studio_module_cover_v1:${target.kind}:${target.id}`;
const historyKey = (target: ModuleCoverTarget, revision: number) => `studio_module_cover_history_v1:${hash(target)}:${revision}`;
const requestKey = (ownerId: string, moduleId: string, requestId: string) => `studio_module_cover_request_v1:${hash([ownerId, moduleId, requestId])}`;
type CoverRecord = { version: 1; ownerId: string; target: ModuleCoverTarget; revision: number; requestId: string;
  recipe: ModuleCoverRecipe; updatedAt: string; files: { thumbnail: string; image: string } };
type CoverReceipt = { ownerId: string; moduleId: string; requestId: string; target: ModuleCoverTarget; fingerprint: string;
  recipe: ModuleCoverRecipe; status: 'pending' | 'saved' | 'failed'; lease: string; expiresAt: number; record?: CoverRecord; error?: string };
type TargetState = { target: ModuleCoverTarget; ownerId: string; canManage: boolean; shared: boolean };

function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value); }
function readObject<T>(value: string): T {
  try { const item = JSON.parse(value); if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(); return item as T; }
  catch { throw new ModuleCoverError('封面记录无法确认，请重新读取', 409); }
}
function parseRecipe(value: unknown): ModuleCoverRecipe {
  const item = value as ModuleCoverRecipe | undefined;
  const output = item?.version === 1 ? LEGACY_MODULE_COVER_OUTPUT : MODULE_COVER_OUTPUT;
  if (!item || item.version !== 1 && item.version !== 2 || !['single', 'horizontal', 'vertical'].includes(item.layout)
    || item.output?.width !== output.width || item.output?.height !== output.height || !Array.isArray(item.sources)
    || item.sources.length !== (item.layout === 'single' ? 1 : 2)) throw new ModuleCoverError('封面排版或尺寸无效');
  const sources = item.sources.map(source => {
    if (!source || !validId(source.assetId) || typeof source.version !== 'string' || !/^[a-f0-9]{64}$/.test(source.version)) throw new ModuleCoverError('封面来源无效');
    const crop = source.crop;
    if (!crop || [crop.x, crop.y, crop.width, crop.height].some(n => typeof n !== 'number' || !Number.isFinite(n))
      || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 100.00001 || crop.y + crop.height > 100.00001) {
      throw new ModuleCoverError('裁剪范围超出图片，请重新调整');
    }
    return { assetId: source.assetId, version: source.version, crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height } };
  });
  // Keep v1's original property order and exact normalized values: its saved
  // request fingerprint includes JSON.stringify(recipe), not a sorted object.
  return item.version === 1
    ? { version: 1, layout: item.layout, output: { width: LEGACY_MODULE_COVER_OUTPUT.width, height: LEGACY_MODULE_COVER_OUTPUT.height }, sources }
    : { version: 2, layout: item.layout, output: { width: MODULE_COVER_OUTPUT.width, height: MODULE_COVER_OUTPUT.height }, sources };
}
function coverOutput(recipe: ModuleCoverRecipe) {
  return recipe.version === 1 ? LEGACY_MODULE_COVER_OUTPUT : MODULE_COVER_OUTPUT;
}
function parseRecord(record: CoverRecord, target: ModuleCoverTarget): CoverRecord {
  if (record.version !== 1 || !validId(record.ownerId) || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !validId(record.requestId) || record.target?.kind !== target.kind || record.target.id !== target.id || !record.files
    || !/^[a-f0-9]{64}-640\.webp$/.test(record.files.thumbnail) || !/^[a-f0-9]{64}-1280\.webp$/.test(record.files.image)
    || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) throw new ModuleCoverError('封面记录无法确认', 409);
  record.recipe = parseRecipe(record.recipe);
  return record;
}
async function readRecord(target: ModuleCoverTarget, client: SharedStudioClient): Promise<{ record: CoverRecord; raw: string } | null> {
  const row = await client.platformSetting.findUnique({ where: { key: moduleCoverKey(target) }, select: { value_json: true } });
  if (!row) return null;
  const record = parseRecord(readObject<CoverRecord>(row.value_json), target);
  return { record, raw: row.value_json };
}
async function targetForPreset(actor: ImageStudioIdentity, presetId: string, client: SharedStudioClient): Promise<TargetState> {
  const source = await client.imageStudioPreset.findUnique({ where: { id: presetId } });
  if (!source || !canViewStudioPreset(actor, source) || await studioPresetArchived(presetId, client)) throw new ModuleCoverError('模板已停止共享或无权查看封面', 403);
  return { target: { kind: 'preset', id: presetId }, ownerId: source.owner_id, canManage: canManageStudioPreset(actor, source), shared: source.is_shared };
}
async function targetForModule(actor: ImageStudioIdentity, moduleId: string, client: SharedStudioClient): Promise<TargetState> {
  if (!validId(moduleId)) throw new ModuleCoverError('模块编号无效');
  const row = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: actor.id } });
  if (!row) throw new ModuleCoverError('请先保存模块，再设置封面', 404);
  const binding = await studioSharedBinding(actor.id, moduleId, client);
  if (binding) {
    const target = await targetForPreset(actor, binding.presetId, client);
    return { ...target, canManage: binding.mode === 'publisher' && target.canManage };
  }
  return { target: { kind: 'module', id: row.id }, ownerId: actor.id, canManage: true, shared: false };
}
async function targetForImage(actor: ImageStudioIdentity, target: ModuleCoverTarget, client: SharedStudioClient) {
  if (!target || !validId(target.id) || !['module', 'preset'].includes(target.kind)) throw new ModuleCoverError('封面编号无效', 404);
  if (target.kind === 'preset') return targetForPreset(actor, target.id, client);
  const state = await targetForModule(actor, target.id, client);
  if (state.target.kind !== 'module') throw new ModuleCoverError('模块封面已转到共享模板，请重新读取', 409);
  return state;
}
const sameTarget = (a: ModuleCoverTarget, b: ModuleCoverTarget) => Boolean(a && b && a.kind === b.kind && a.id === b.id);
async function sourceVersion(asset: Asset) {
  let fileVersion: unknown = null;
  const local = siteUploadPathFromUrl(asset.original_url);
  // A remote URL alone cannot identify the bytes used by the crop. Require the
  // existing import/upload flow's persistent original, rather than downloading
  // originals for every card or silently accepting a mutable remote source.
  if (!local) throw new ModuleCoverError('这张原图尚未存到本地素材库，请先导入原件再设置封面', 409);
  if (local) {
    const root = await fs.realpath(path.join(process.cwd(), 'public/uploads'));
    const file = await fs.realpath(path.resolve(process.cwd(), 'public', local.replace(/^\/+/, '')));
    if (!file.startsWith(`${root}${path.sep}`)) throw new ModuleCoverError('原图路径无法确认', 409);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 40 * 1024 * 1024) throw new ModuleCoverError('封面原图过大或不可用', 409);
    fileVersion = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  }
  return hash([asset.id, asset.owner_id, asset.original_url, asset.hash, asset.file_size, asset.width, asset.height, asset.mime_type, fileVersion]);
}
async function authorizedSources(actor: ImageStudioIdentity, state: TargetState, ids: string[], client: SharedStudioClient) {
  if (!ids.length || ids.length > 2 || ids.some(id => !validId(id))) throw new ModuleCoverError('请选择一张或两张合法图片');
  const assets = await client.asset.findMany({ where: { id: { in: Array.from(new Set(ids)) }, owner_id: state.ownerId, type: 'image', status: 'active' } });
  // Viewing an administrator's private/fixed picture is not permission to publish it.
  const hidden = await studioHiddenAssetUrls(state.shared ? { id: 'module-cover-audience', role: 'user', account_type: 'internal' } : actor, client);
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return Promise.all(ids.map(async id => {
    const asset = byId.get(id);
    if (!asset || hidden.includes(asset.original_url)) throw new ModuleCoverError('这张原图无权用于当前模块展示，请换图', 403);
    return { asset, version: await sourceVersion(asset) };
  }));
}
function imageURL(target: ModuleCoverTarget, revision: number, size: 640 | 1280) {
  return `/api/image-studio/module-covers/${target.kind}/${encodeURIComponent(target.id)}?revision=${revision}&size=${size}`;
}
async function recordDTO(actor: ImageStudioIdentity, state: TargetState, record: CoverRecord, client: SharedStudioClient): Promise<ModuleCoverDTO> {
  let unavailableReason: string | undefined;
  try {
    if (record.ownerId !== state.ownerId || !sameTarget(state.target, record.target)) throw new ModuleCoverError('封面归属已变化', 409);
    const sources = await authorizedSources(actor, state, record.recipe.sources.map(source => source.assetId), client);
    if (sources.some((source, index) => source.version !== record.recipe.sources[index].version)) throw new ModuleCoverError('封面原图已变化，请管理者重新选图', 409);
  } catch { unavailableReason = '封面原图已不可用或权限已变化，请管理者换图'; }
  return { target: state.target, revision: record.revision, available: !unavailableReason,
    thumbnailUrl: unavailableReason ? null : imageURL(state.target, record.revision, 640), imageUrl: unavailableReason ? null : imageURL(state.target, record.revision, 1280),
    width: coverOutput(record.recipe).width, height: coverOutput(record.recipe).height, updatedAt: record.updatedAt, ...(unavailableReason ? { unavailableReason } : {}) };
}
export async function studioFixedCoverDTO(actor: ImageStudioIdentity, target: ModuleCoverTarget, client: SharedStudioClient = prisma): Promise<ModuleCoverDTO | null> {
  const stored = await readRecord(target, client);
  if (!stored) return null;
  try { return await recordDTO(actor, await targetForImage(actor, target, client), stored.record, client); }
  catch { return { target, revision: stored.record.revision, available: false, thumbnailUrl: null, imageUrl: null,
    width: coverOutput(stored.record.recipe).width, height: coverOutput(stored.record.recipe).height,
    updatedAt: stored.record.updatedAt, unavailableReason: '模板已不可用或停止共享' }; }
}
async function inspectSources(actor: ImageStudioIdentity, state: TargetState, ids: string[], client: SharedStudioClient): Promise<ModuleCoverSourceDTO[]> {
  if (activeJobs >= 2) throw new ModuleCoverError('正在处理其他封面，请稍后重试', 429);
  activeJobs += 1;
  try {
    const sources = await authorizedSources(actor, state, ids, client);
    const inspected: ModuleCoverSourceDTO[] = [];
    for (const { asset, version } of sources) {
      const bytes = await readStudioImage(asset.original_url, AbortSignal.timeout(30000));
      if (bytes.length > 40 * 1024 * 1024) throw new ModuleCoverError('封面原图过大');
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' }).metadata();
      if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new ModuleCoverError('请选择普通静态图片');
      if (version !== await sourceVersion(asset)) throw new ModuleCoverError('原图刚刚变化，请重新选择', 409);
      const swapped = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
      inspected.push({ assetId: asset.id, version, previewUrl: `${studioTemplateAssetUrl(asset.id)}?preview=1`,
        width: swapped ? metadata.height : metadata.width, height: swapped ? metadata.width : metadata.height });
    }
    return inspected;
  } finally { activeJobs -= 1; }
}
export async function readModuleCoverEditor(user: ImageStudioIdentity, moduleId: string, requestedIds?: string[]): Promise<ModuleCoverEditorState> {
  const actor = await assertStudioActor(user.id);
  const state = await targetForModule(actor, moduleId, prisma);
  const stored = await readRecord(state.target, prisma);
  const fixedCover = stored ? await recordDTO(actor, state, stored.record, prisma) : null;
  if (requestedIds && !state.canManage) throw new ModuleCoverError('仅模板管理者可以选图', 403);
  let sources: ModuleCoverSourceDTO[] = [];
  let sourceError: string | undefined;
  if (state.canManage) {
    const ids = requestedIds ?? stored?.record.recipe.sources.map(source => source.assetId);
    if (ids?.length) {
      try { sources = await inspectSources(actor, state, ids, prisma); }
      catch (error) { if (requestedIds) throw error; sourceError = '原图已不可用，可重新选择封面图片'; }
    }
    if (!requestedIds && stored && sources.some((source, index) => source.version !== stored.record.recipe.sources[index]?.version)) sourceError = '原图已变化，请核对取景后再保存';
  }
  return { target: state.target, revision: stored?.record.revision ?? 0, canManage: state.canManage, fixedCover,
    recipe: state.canManage ? stored?.record.recipe ?? null : null, sources, ...(sourceError ? { sourceError } : {}) };
}
async function coverDirectory(write = false) {
  // storage is the existing persistent deployment symlink, outside anonymous public uploads.
  const root = await fs.realpath(path.join(process.cwd(), 'storage'));
  if (process.env.NODE_ENV === 'production') {
    const data = await fs.realpath('/data');
    const [dataStat, systemStat, rootStat] = await Promise.all([fs.stat(data), fs.stat('/'), fs.stat(root)]);
    if (!root.startsWith(`${data}${path.sep}`) || dataStat.dev === systemStat.dev || rootStat.dev !== dataStat.dev) {
      throw new ModuleCoverError('封面存储未连接数据盘，请联系管理员', 503);
    }
  }
  const folder = path.join(root, 'module-covers');
  if (write) await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const real = await fs.realpath(folder);
  if (real !== folder) throw new ModuleCoverError('封面存储路径无法确认', 503);
  return real;
}
async function publishCoverFile(directory: string, name: string, bytes: Buffer) {
  const file = path.join(directory, name);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    const folder = await fs.open(directory, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
    if (!(await fs.readFile(file)).equals(bytes)) throw new ModuleCoverError('封面文件落盘未确认，旧封面仍保留', 503);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
let activeJobs = 0;
async function renderCover(actor: ImageStudioIdentity, state: TargetState, recipe: ModuleCoverRecipe) {
  if (activeJobs >= 2) throw new ModuleCoverError('正在保存其他封面，请稍后重试', 429);
  activeJobs += 1;
  try {
    const output = coverOutput(recipe);
    const sources = await authorizedSources(actor, state, recipe.sources.map(source => source.assetId), prisma);
    const tiles: Array<{ input: Buffer; left: number; top: number }> = [];
    for (let index = 0; index < sources.length; index++) {
      const { asset, version } = sources[index];
      const input = recipe.sources[index];
      if (input.version !== version) throw new ModuleCoverError('原图已变化，请重新选择后保存', 409);
      const bytes = await readStudioImage(asset.original_url, AbortSignal.timeout(30000));
      if (bytes.length > 40 * 1024 * 1024) throw new ModuleCoverError('封面原图过大');
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' }).metadata();
      if ((metadata.pages ?? 1) > 1) throw new ModuleCoverError('请选择普通静态图片');
      const oriented = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' }).timeout({ seconds: 30 }).rotate().raw().toBuffer({ resolveWithObject: true });
      const { width, height, channels } = oriented.info;
      const tileWidth = recipe.layout === 'horizontal' ? output.width / 2 : output.width;
      const tileHeight = recipe.layout === 'vertical' ? output.height / 2 : output.height;
      // Cropper emits percentages of the oriented original. Use matching pixel rounding.
      const left = Math.min(width - 1, Math.round(width * input.crop.x / 100));
      const top = Math.min(height - 1, Math.round(height * input.crop.y / 100));
      const cropWidth = Math.min(width - left, Math.round(width * input.crop.width / 100));
      const cropHeight = Math.min(height - top, Math.round(height * input.crop.height / 100));
      if (cropWidth < 1 || cropHeight < 1 || Math.abs(cropWidth / cropHeight - tileWidth / tileHeight) > Math.max(0.01, 3 / cropHeight)) {
        throw new ModuleCoverError('裁剪比例与封面格子不一致，请重新调整');
      }
      const tile = await sharp(oriented.data, { raw: { width, height, channels } }).timeout({ seconds: 30 })
        .extract({ left, top, width: cropWidth, height: cropHeight }).resize(tileWidth, tileHeight, { fit: 'fill' }).png().toBuffer();
      tiles.push({ input: tile, left: recipe.layout === 'horizontal' ? index * tileWidth : 0, top: recipe.layout === 'vertical' ? index * tileHeight : 0 });
      if (version !== await sourceVersion(asset)) throw new ModuleCoverError('原图刚刚变化，请重新选择', 409);
    }
    const image = await sharp({ create: { width: output.width, height: output.height, channels: 4, background: '#0b0e0f' } })
      .composite(tiles).timeout({ seconds: 30 }).webp({ quality: 84 }).toBuffer();
    const thumbnail = await sharp(image).resize(output.thumbnailWidth, output.thumbnailHeight).webp({ quality: 80 }).toBuffer();
    return { image, thumbnail };
  } finally { activeJobs -= 1; }
}
async function writeReceipt(client: SharedStudioClient, key: string, receipt: CoverReceipt) {
  const value_json = JSON.stringify(receipt);
  await client.platformSetting.upsert({ where: { key }, create: { key, value_json, updated_by: receipt.ownerId }, update: { value_json, updated_by: receipt.ownerId } });
}
function validReceipt(value: CoverReceipt, ownerId: string, moduleId: string, requestId: string) {
  if (value.ownerId !== ownerId || value.moduleId !== moduleId || value.requestId !== requestId
    || !['saved', 'pending', 'failed'].includes(value.status) || !['module', 'preset'].includes(value.target?.kind) || !validId(value.target?.id)
    || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !validId(value.lease) || !Number.isFinite(value.expiresAt)) throw new ModuleCoverError('封面保存回执无法确认', 409);
  value.recipe = parseRecipe(value.recipe);
  if (value.record) {
    value.record = parseRecord(value.record, value.target);
    if (value.record.ownerId !== ownerId || value.record.requestId !== requestId || hash(value.record.recipe) !== hash(value.recipe)) {
      throw new ModuleCoverError('封面保存回执与成品记录不匹配', 409);
    }
  }
}
async function receiptResult(actor: ImageStudioIdentity, state: TargetState, receipt: CoverReceipt, client: SharedStudioClient): Promise<ModuleCoverRequestResult> {
  if (!sameTarget(state.target, receipt.target)) throw new ModuleCoverError('模块共享关系已变化，请重新读取', 409);
  if (receipt.status === 'saved' && receipt.record) {
    const current = await readRecord(state.target, client);
    const superseded = Boolean(current && current.record.revision !== receipt.record.revision);
    return { status: 'saved', requestId: receipt.requestId, revision: receipt.record.revision,
      fixedCover: await recordDTO(actor, state, current?.record ?? receipt.record, client), ...(superseded ? { superseded: true } : {}) };
  }
  return { status: receipt.status === 'pending' && receipt.expiresAt <= Date.now() ? 'failed' : receipt.status === 'saved' ? 'failed' : receipt.status,
    requestId: receipt.requestId, ...(receipt.error ? { error: receipt.error } : receipt.expiresAt <= Date.now() && receipt.status === 'pending' ? { error: '上次保存未完成，可沿用原请求安全重试' } : {}) };
}
export async function readModuleCoverRequest(user: ImageStudioIdentity, moduleId: string, requestId: string): Promise<ModuleCoverRequestResult> {
  if (!validId(requestId)) throw new ModuleCoverError('保存请求编号无效');
  const actor = await assertStudioActor(user.id);
  const state = await targetForModule(actor, moduleId, prisma);
  if (!state.canManage) throw new ModuleCoverError('无权查询封面保存结果', 403);
  const row = await prisma.platformSetting.findUnique({ where: { key: requestKey(actor.id, moduleId, requestId) }, select: { value_json: true } });
  if (!row) return { status: 'not-found', requestId };
  const receipt = readObject<CoverReceipt>(row.value_json);
  validReceipt(receipt, actor.id, moduleId, requestId);
  return receiptResult(actor, state, receipt, prisma);
}
export async function saveModuleCover(user: ImageStudioIdentity, moduleId: string, body: ModuleCoverSaveInput): Promise<ModuleCoverRequestResult> {
  if (!body || !validId(body.requestId) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
    || !body.target || !['module', 'preset'].includes(body.target.kind) || !validId(body.target.id)) throw new ModuleCoverError('保存请求无效');
  const recipe = parseRecipe(body.recipe);
  const actor = await assertStudioActor(user.id);
  const key = requestKey(actor.id, moduleId, body.requestId);
  const fingerprint = hash([moduleId, body.target, body.expectedRevision, recipe]);
  const lease = randomUUID();
  const reserved = await prisma.$transaction(async tx => {
    const freshActor = await assertStudioActor(actor.id, tx);
    const state = await targetForModule(freshActor, moduleId, tx);
    if (!state.canManage) throw new ModuleCoverError('仅模板管理者可以保存封面', 403);
    if (!sameTarget(state.target, body.target)) throw new ModuleCoverError('共享关系已变化，请重新打开封面设置', 409);
    const priorRow = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    if (priorRow) {
      const prior = readObject<CoverReceipt>(priorRow.value_json);
      validReceipt(prior, actor.id, moduleId, body.requestId);
      if (!sameTarget(prior.target, body.target) || prior.fingerprint !== fingerprint) throw new ModuleCoverError('同一个保存编号不能提交不同封面', 409);
      if (prior.status === 'saved' || prior.status === 'pending' && prior.expiresAt > Date.now()) return { state, prior };
    } else if (recipe.version !== 2) throw new ModuleCoverError('封面已升级为正方形，请刷新页面后重新取景保存；旧裁剪不会自动改动', 428);
    const stored = await readRecord(state.target, tx);
    if ((stored?.record.revision ?? 0) !== body.expectedRevision) throw new ModuleCoverError('封面已被其他页面修改，请重新打开核对', 409);
    const sources = await authorizedSources(freshActor, state, recipe.sources.map(source => source.assetId), tx);
    if (sources.some((source, index) => source.version !== recipe.sources[index].version)) throw new ModuleCoverError('原图已变化，请重新选择', 409);
    const receipt: CoverReceipt = { ownerId: actor.id, moduleId, requestId: body.requestId, target: state.target,
      fingerprint, recipe, status: 'pending', lease, expiresAt: Date.now() + 180000 };
    await writeReceipt(tx, key, receipt);
    return { state, receipt };
  });
  if (reserved.prior) return receiptResult(actor, reserved.state, reserved.prior, prisma);
  const receipt = reserved.receipt!;
  try {
    const { image, thumbnail } = await renderCover(actor, reserved.state, recipe);
    const directory = await coverDirectory(true);
    // Content names are immutable; a failed CAS only leaves unreferenced private files.
    const name = hash([createHash('sha256').update(image).digest('hex'), createHash('sha256').update(thumbnail).digest('hex')]);
    const files = { thumbnail: `${name}-640.webp`, image: `${name}-1280.webp` };
    await publishCoverFile(directory, files.image, image);
    await publishCoverFile(directory, files.thumbnail, thumbnail);
    return await prisma.$transaction(async tx => {
      const freshActor = await assertStudioActor(actor.id, tx);
      const state = await targetForModule(freshActor, moduleId, tx);
      if (!state.canManage || !sameTarget(state.target, receipt.target)) throw new ModuleCoverError('共享关系或管理权限已变化，旧封面仍保留', 409);
      const savedReceipt = await tx.platformSetting.findUniqueOrThrow({ where: { key }, select: { value_json: true } });
      const pending = readObject<CoverReceipt>(savedReceipt.value_json);
      validReceipt(pending, actor.id, moduleId, body.requestId);
      if (!sameTarget(pending.target, receipt.target) || pending.fingerprint !== fingerprint) throw new ModuleCoverError('封面保存回执已变化，请保留原请求编号核对', 409);
      if (pending.status !== 'pending' || pending.lease !== lease || pending.expiresAt <= Date.now()) throw new ModuleCoverError('本次保存已过期，请先核对结果', 409);
      const sources = await authorizedSources(freshActor, state, recipe.sources.map(source => source.assetId), tx);
      if (sources.some((source, index) => source.version !== recipe.sources[index].version)) throw new ModuleCoverError('原图或展示权限已变化，旧封面仍保留', 409);
      const before = await readRecord(state.target, tx);
      if ((before?.record.revision ?? 0) !== body.expectedRevision) throw new ModuleCoverError('封面已被他人修改，旧输入仍保留', 409);
      const record: CoverRecord = { version: 1, ownerId: state.ownerId, target: state.target, revision: body.expectedRevision + 1,
        requestId: body.requestId, recipe, updatedAt: new Date().toISOString(), files };
      const value_json = JSON.stringify(record);
      if (before) {
        const change = await tx.platformSetting.updateMany({ where: { key: moduleCoverKey(state.target), value_json: before.raw }, data: { value_json, updated_by: actor.id } });
        if (change.count !== 1) throw new ModuleCoverError('封面同时被修改，请重新读取', 409);
      } else await tx.platformSetting.create({ data: { key: moduleCoverKey(state.target), value_json, updated_by: actor.id } });
      await tx.platformSetting.create({ data: { key: historyKey(state.target, record.revision), value_json, updated_by: actor.id } });
      if (state.target.kind === 'preset') {
        const preset = await tx.imageStudioPreset.findUniqueOrThrow({ where: { id: state.target.id } });
        await tx.imageStudioPreset.update({ where: { id: preset.id }, data: { updated_at: new Date(Math.max(Date.now(), preset.updated_at.getTime() + 1)) } });
      }
      await writeReceipt(tx, key, { ...receipt, status: 'saved', record });
      return { status: 'saved' as const, requestId: body.requestId, revision: record.revision, fixedCover: await recordDTO(freshActor, state, record, tx) };
    });
  } catch (error) {
    const message = error instanceof ModuleCoverError ? error.message : '封面保存失败，旧封面和输入仍保留';
    // Never replace a completed receipt or another attempt's lease after an uncertain commit.
    await prisma.platformSetting.updateMany({ where: { key, value_json: JSON.stringify(receipt) },
      data: { value_json: JSON.stringify({ ...receipt, status: 'failed', error: message }) } }).catch(() => {});
    throw error instanceof ModuleCoverError ? error : new ModuleCoverError(message, 503);
  }
}
export async function readModuleCoverImage(user: ImageStudioIdentity, target: ModuleCoverTarget, revision: number, size: 640 | 1280) {
  const actor = await assertStudioActor(user.id);
  const state = await targetForImage(actor, target, prisma);
  const stored = await readRecord(target, prisma);
  if (!stored || stored.record.revision !== revision) throw new ModuleCoverError('封面已更新，请重新读取', 404);
  if (!(await recordDTO(actor, state, stored.record, prisma)).available) throw new ModuleCoverError('封面已不可用', 403);
  const directory = await coverDirectory();
  const file = await fs.realpath(path.join(directory, size === 640 ? stored.record.files.thumbnail : stored.record.files.image));
  if (!file.startsWith(`${directory}${path.sep}`)) throw new ModuleCoverError('封面文件不可用', 404);
  const info = await fs.stat(file);
  if (!info.isFile() || info.size <= 0 || info.size > 4 * 1024 * 1024) throw new ModuleCoverError('封面文件不可用', 503);
  const bytes = await fs.readFile(file);
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new ModuleCoverError('封面文件不可用', 503);
  const output = coverOutput(stored.record.recipe);
  const width = size === 640 ? output.thumbnailWidth : output.width;
  const height = size === 640 ? output.thumbnailHeight : output.height;
  let metadata;
  try { metadata = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' }).metadata(); }
  catch { throw new ModuleCoverError('封面文件无法读取，请管理者重新设置', 503); }
  if (metadata.format !== 'webp' || metadata.width !== width || metadata.height !== height || (metadata.pages ?? 1) > 1) {
    throw new ModuleCoverError('封面文件尺寸与保存记录不一致，请管理者重新设置', 503);
  }
  return bytes;
}

// Promotion copies only an explicitly saved cover, never the latest task/banner fallback.
// An existing preset cover always wins over stale module metadata.
export async function promoteModuleCover(actor: ImageStudioIdentity, moduleId: string, presetId: string, client: SharedStudioClient) {
  return copyModuleCover(actor, { kind: 'module', id: moduleId }, { kind: 'preset', id: presetId }, client);
}
export async function assertPresetCoverShareable(actor: ImageStudioIdentity, presetId: string, client: SharedStudioClient) {
  const target: ModuleCoverTarget = { kind: 'preset', id: presetId };
  const stored = await readRecord(target, client);
  if (!stored) return;
  const state = await targetForPreset(actor, presetId, client);
  if (!state.canManage || stored.record.ownerId !== state.ownerId) throw new ModuleCoverError('封面归属无法确认，不能共享', 403);
  const sources = await authorizedSources(actor, { ...state, shared: true }, stored.record.recipe.sources.map(source => source.assetId), client);
  if (sources.some((source, index) => source.version !== stored.record.recipe.sources[index].version)) throw new ModuleCoverError('封面原图已变化，请先重新设置封面再共享', 409);
}
export async function copyModuleCover(actor: ImageStudioIdentity, from: ModuleCoverTarget, to: ModuleCoverTarget, client: SharedStudioClient) {
  if (await readRecord(to, client)) return;
  const prior = await readRecord(from, client);
  if (!prior) return;
  const state = await targetForPreset(actor, to.id, client);
  if (!state.canManage || prior.record.ownerId !== state.ownerId) throw new ModuleCoverError('不能公开他人的封面', 403);
  const sources = await authorizedSources(actor, state, prior.record.recipe.sources.map(source => source.assetId), client);
  if (sources.some((source, index) => source.version !== prior.record.recipe.sources[index].version)) throw new ModuleCoverError('原封面来源已变化，请重新设置后共享', 409);
  const record: CoverRecord = { ...prior.record, target: to, revision: 1, updatedAt: new Date().toISOString() };
  const value_json = JSON.stringify(record);
  await client.platformSetting.create({ data: { key: moduleCoverKey(to), value_json, updated_by: actor.id } });
  await client.platformSetting.create({ data: { key: historyKey(to, 1), value_json, updated_by: actor.id } });
}
