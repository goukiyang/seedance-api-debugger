import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Asset } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { canManageStudioPreset, canViewStudioPreset, type ImageStudioIdentity } from './access';
import { assertStudioActor, studioPublisherModule, studioSharedBinding, type SharedStudioClient } from './shared-contract';
import { studioPresetArchived } from './preset-lifecycle';
import { StudioSharingError } from './shared-command-storage';
import { assertStudioWorkspaceNotDeleted, readStudioDeletedSource } from './workspace-deletion';
import { studioHiddenAssetUrls } from './protected-assets';
import { readStudioImage, studioTemplateAssetUrl } from './media';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from './dimension-mismatch';
import { LEGACY_MODULE_COVER_OUTPUT, MODULE_COVER_OUTPUT, type ModuleCoverDTO, type ModuleCoverEditorState, type ModuleCoverRecipe,
  type ModuleCoverRequestResult, type ModuleCoverSnapshotRequestResult, type ModuleCoverSaveInput, type ModuleCoverSourceDTO, type ModuleCoverTarget } from './module-cover-types';

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
type SnapshotRecipe = Extract<ModuleCoverRecipe, { version: 3 }>;
type SnapshotBinding = {
  version: 1; ownerId: string; moduleId: string; moduleRevision: number; targetPresetId: string; requestId: string;
  operationFingerprint: string; fingerprint: string; lease: string; expiresAt: number;
  disposition: 'image' | 'none' | 'existing'; recipe: SnapshotRecipe | null; taskId?: string;
  moduleCoverHash: string | null; presetCoverHash: string | null;
};
export type PreparedModuleCoverSnapshot = SnapshotBinding & { status: 'ready'; files?: { thumbnail: string; image: string } };
type CoverPreparation = SnapshotBinding & { status: 'pending' | 'ready' | 'failed' | 'committed';
  files?: { thumbnail: string; image: string }; error?: string };
export type ModuleCoverSnapshotCommit = { moduleId: string; targetPresetId: string; sourceModuleId: string; sourceBeforeRevision: number;
  beforeRevision: number; afterRevision: number; operationFingerprint: string };

function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value); }
function readObject<T>(value: string): T {
  try { const item = JSON.parse(value); if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(); return item as T; }
  catch { throw new ModuleCoverError('封面记录无法确认，请重新读取', 409); }
}
function parseRecipe(value: unknown, allowInternalV3 = false): ModuleCoverRecipe {
  const item = value as ModuleCoverRecipe | undefined;
  const output = item?.version === 1 ? LEGACY_MODULE_COVER_OUTPUT : MODULE_COVER_OUTPUT;
  if (!item || item.version !== 1 && item.version !== 2 && (!allowInternalV3 || item.version !== 3)
    || item.version === 3 && (item.layout !== 'single' || item.fit !== 'contain')
    || !['single', 'horizontal', 'vertical'].includes(item.layout)
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
  if (item.version === 3) {
    const source = sources[0];
    if (source.crop.x !== 0 || source.crop.y !== 0 || source.crop.width !== 100 || source.crop.height !== 100) {
      throw new ModuleCoverError('自动封面必须保留完整画面');
    }
    return { version: 3, layout: 'single', fit: 'contain', output: { width: MODULE_COVER_OUTPUT.width, height: MODULE_COVER_OUTPUT.height }, sources: [source] };
  }
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
  record.recipe = parseRecipe(record.recipe, true);
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
  await assertStudioWorkspaceNotDeleted(actor.id, moduleId, client);
  const binding = await studioSharedBinding(actor.id, moduleId, client);
  if (binding) {
    const target = await targetForPreset(actor, binding.presetId, client);
    return { ...target, canManage: binding.mode === 'publisher' && target.canManage };
  }
  // A provable legacy source projects the same preset cover without creating
  // a new publisher binding. Other owners' personal copies remain read-only.
  if (row.source_preset_id) {
    const source = await client.imageStudioPreset.findUnique({ where: { id: row.source_preset_id } });
    if (source && (source.is_shared || source.owner_id !== actor.id)) {
      const target = await targetForPreset(actor, source.id, client);
      let legacyOwner = false;
      if (source.owner_id === actor.id && !await readStudioDeletedSource(actor.id, source.id, client)) {
        const publisher = await studioPublisherModule(actor.id, source.id, client);
        if (publisher) legacyOwner = publisher === row.id;
        else if (source.id.startsWith('module-source:')) legacyOwner = source.id === `module-source:${row.id}`;
        else {
          const candidates = await client.imageStudioModule.findMany({ where: { owner_id: actor.id, source_preset_id: source.id }, select: { id: true } });
          legacyOwner = candidates.length === 1 && candidates[0].id === row.id;
        }
      }
      return { ...target, canManage: target.canManage && legacyOwner };
    }
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
const prepareKey = (ownerId: string, moduleId: string, requestId: string) => `studio_module_cover_prepare_v3:${hash([ownerId, moduleId, requestId])}`;
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
async function sharedDataDiskDirectory(real: string) {
  const data = await fs.realpath('/data').catch(() => null);
  if (!data || !real.startsWith(`${data}${path.sep}`)) return false;
  const [stat, dataStat, systemStat] = await Promise.all([fs.stat(real), fs.stat(data), fs.stat('/')]);
  return stat.isDirectory() && stat.dev === dataStat.dev && dataStat.dev !== systemStat.dev;
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
  if (write) {
    const disk = await fs.statfs(root);
    if (Number(disk.bavail) * Number(disk.bsize) < 32 * 1024 * 1024) throw new ModuleCoverError('封面存储空间不足，原封面仍保留', 503);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  }
  const real = await fs.realpath(folder);
  // Releases link module-covers to the shared data-disk store (since 2026-10-18); accept only such a link.
  if (real !== folder && !await sharedDataDiskDirectory(real)) throw new ModuleCoverError('封面存储路径无法确认', 503);
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
async function assertCoverFilesPresent(files: { thumbnail: string; image: string }) {
  const directory = await coverDirectory();
  for (const name of [files.image, files.thumbnail]) {
    const real = await fs.realpath(path.join(directory, name));
    if (!real.startsWith(`${directory}${path.sep}`)) throw new ModuleCoverError('封面文件路径无法确认', 503);
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 4 * 1024 * 1024) throw new ModuleCoverError('封面文件尚未就绪，原封面仍保留', 503);
  }
}
async function verifyPreparedCoverFiles(files: { thumbnail: string; image: string }) {
  await assertCoverFilesPresent(files);
  const directory = await coverDirectory();
  const [image, thumbnail] = await Promise.all([fs.readFile(path.join(directory, files.image)), fs.readFile(path.join(directory, files.thumbnail))]);
  const name = hash([createHash('sha256').update(image).digest('hex'), createHash('sha256').update(thumbnail).digest('hex')]);
  if (files.image !== `${name}-1280.webp` || files.thumbnail !== `${name}-640.webp`)
    throw new ModuleCoverError('封面文件完整性无法确认，原候选仍保留', 503);
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
      if (recipe.version === 3) {
        const tile = await sharp(oriented.data, { raw: { width, height, channels } }).timeout({ seconds: 30 })
          .resize(tileWidth, tileHeight, { fit: 'contain', background: '#0b0e0f', withoutEnlargement: true }).png().toBuffer();
        tiles.push({ input: tile, left: 0, top: 0 });
        if (version !== await sourceVersion(asset)) throw new ModuleCoverError('原图刚刚变化，请重新选择', 409);
        continue;
      }
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

const preparationFingerprint = (value: SnapshotBinding) => hash(['first-shared-cover-v3', value.ownerId, value.moduleId,
  value.moduleRevision, value.targetPresetId, value.requestId, value.operationFingerprint, value.disposition,
  value.recipe, value.taskId || null, value.moduleCoverHash, value.presetCoverHash]);
function parsePreparation(value: string, ownerId: string, moduleId: string, requestId: string): CoverPreparation {
  const parsed = readObject<CoverPreparation>(value);
  if (parsed.version !== 1 || parsed.ownerId !== ownerId || parsed.moduleId !== moduleId || parsed.requestId !== requestId
    || !Number.isSafeInteger(parsed.moduleRevision) || parsed.moduleRevision < 1 || !validId(parsed.targetPresetId)
    || !validId(parsed.lease) || !/^[a-f0-9]{64}$/.test(parsed.fingerprint) || !/^[a-f0-9]{64}$/.test(parsed.operationFingerprint)
    || !Number.isFinite(parsed.expiresAt) || !['pending', 'ready', 'failed', 'committed'].includes(parsed.status)
    || !['image', 'none', 'existing'].includes(parsed.disposition)
    || [parsed.moduleCoverHash, parsed.presetCoverHash].some(item => item !== null && !/^[a-f0-9]{64}$/.test(item))) {
    throw new ModuleCoverError('自动封面准备记录无法确认，请核对原保存请求', 409);
  }
  if (parsed.disposition === 'image') {
    parsed.recipe = parseRecipe(parsed.recipe, true) as SnapshotRecipe;
    if (parsed.recipe.version !== 3 || parsed.status === 'ready' && (!parsed.files
      || !/^[a-f0-9]{64}-640\.webp$/.test(parsed.files.thumbnail) || !/^[a-f0-9]{64}-1280\.webp$/.test(parsed.files.image))) {
      throw new ModuleCoverError('自动封面准备记录不完整', 409);
    }
  } else if (parsed.recipe !== null || parsed.files !== undefined) throw new ModuleCoverError('自动封面准备身份无法确认', 409);
  if (parsed.fingerprint !== preparationFingerprint(parsed)) throw new ModuleCoverError('自动封面与原操作不一致', 409);
  return parsed;
}
function assertPreparationOperation(prior: CoverPreparation, targetPresetId: string, operationFingerprint: string) {
  if (prior.targetPresetId !== targetPresetId || prior.operationFingerprint !== operationFingerprint)
    throw new ModuleCoverError('同一个保存编号不能用于不同模板操作', 409);
}

/** Freeze the choice once; an expired/failed lease can only render that same choice. */
export async function prepareModuleCoverSnapshot(user: ImageStudioIdentity, moduleId: string, requestId: string,
  targetPresetId = `module-source:${moduleId}`, operationFingerprint?: string): Promise<PreparedModuleCoverSnapshot | null> {
  if (!validId(moduleId) || !validId(requestId) || !validId(targetPresetId) || !/^[a-f0-9]{64}$/.test(operationFingerprint || ''))
    throw new ModuleCoverError('自动封面准备参数无效');
  const actor = await assertStudioActor(user.id), key = prepareKey(actor.id, moduleId, requestId);
  const reserve = () => prisma.$transaction(async tx => {
    const fresh = await assertStudioActor(actor.id, tx);
    const priorRow = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    if (priorRow) {
      const prior = parsePreparation(priorRow.value_json, actor.id, moduleId, requestId);
      assertPreparationOperation(prior, targetPresetId, operationFingerprint!);
      if (prior.status === 'committed') throw new ModuleCoverError('原封面已随模板提交，请核对原保存回执', 409);
      if (prior.status === 'ready' && prior.expiresAt > Date.now()) return prior;
      if (prior.status === 'pending' && prior.expiresAt > Date.now()) throw new ModuleCoverError('自动封面仍在准备，请沿原请求核对', 409);
      const renewed: CoverPreparation = { ...prior, lease: randomUUID(), expiresAt: Date.now() + 180000,
        status: prior.files || prior.disposition !== 'image' ? 'ready' : 'pending', error: undefined };
      const changed = await tx.platformSetting.updateMany({ where: { key, value_json: priorRow.value_json },
        data: { value_json: JSON.stringify(renewed), updated_by: actor.id } });
      if (changed.count !== 1) throw new ModuleCoverError('原封面准备正在接续，请核对原请求', 409);
      return renewed;
    }
    const workspace = await tx.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: actor.id } });
    if (!workspace) throw new ModuleCoverError('模板工作区不存在或无权读取', 404);
    await assertStudioWorkspaceNotDeleted(actor.id, moduleId, tx);
    // Existing shared definitions never acquire a later private result as part
    // of an ordinary definition save or sharing toggle.
    if (await studioSharedBinding(actor.id, moduleId, tx)) return null;
    if (workspace.source_preset_id) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: workspace.source_preset_id } });
      if (!source || source.owner_id !== fresh.id || source.is_shared) return null;
    }
    const [moduleCover, presetCover] = await Promise.all([
      readRecord({ kind: 'module', id: moduleId }, tx), readRecord({ kind: 'preset', id: targetPresetId }, tx),
    ]);
    const pending: CoverPreparation = { version: 1, ownerId: fresh.id, moduleId, moduleRevision: workspace.revision,
      targetPresetId, requestId, operationFingerprint: operationFingerprint!, fingerprint: '', lease: randomUUID(),
      expiresAt: Date.now() + 180000, status: 'ready', disposition: moduleCover || presetCover ? 'existing' : 'none',
      recipe: null, moduleCoverHash: moduleCover ? hash(moduleCover.raw) : null, presetCoverHash: presetCover ? hash(presetCover.raw) : null };
    if (!moduleCover && !presetCover) {
      const latest = await tx.imageStudioTask.findFirst({ where: { module_id: moduleId, owner_id: actor.id, deleted_at: null,
        asset_id: { not: null }, AND: [studioOutputTaskWhere] }, orderBy: [{ finished_at: 'desc' }, { id: 'desc' }],
        select: { id: true, asset_id: true, status: true, usage_json: true } });
      const candidateId = latest?.asset_id && studioTaskHasViewableOutput(latest) ? latest.asset_id : workspace.banner_asset_id;
      if (candidateId) {
        try {
          const state: TargetState = { target: { kind: 'module', id: moduleId }, ownerId: actor.id, canManage: true, shared: true };
          const [source] = await authorizedSources(fresh, state, [candidateId], tx);
          pending.recipe = { version: 3, layout: 'single', fit: 'contain', output: { width: 1280, height: 1280 },
            sources: [{ assetId: source.asset.id, version: source.version, crop: { x: 0, y: 0, width: 100, height: 100 } }] };
          pending.disposition = 'image'; pending.status = 'pending';
          if (latest?.asset_id === candidateId) pending.taskId = latest.id;
        } catch (error) {
          if (!(error instanceof ModuleCoverError) && !['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
          // A protected/unavailable source is a durable no-cover decision. It
          // never falls back to an input or a future private result.
        }
      }
    }
    pending.fingerprint = preparationFingerprint(pending);
    await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(pending), updated_by: actor.id } });
    return pending;
  }, { timeout: 15000 });
  let reserved: CoverPreparation | null;
  try { reserved = await reserve(); }
  catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    // A concurrent reservation wins intact. Read and bind to it, never upsert.
    reserved = await reserve();
  }
  if (!reserved) return null;
  if (reserved.status === 'ready') {
    if (reserved.disposition === 'image') {
      try { await verifyPreparedCoverFiles(reserved.files!); }
      catch (error) {
        const failed = { ...reserved, status: 'failed', files: undefined, error: '准备文件尚未就绪，原候选已保留' };
        await prisma.platformSetting.updateMany({ where: { key, value_json: JSON.stringify(reserved) },
          data: { value_json: JSON.stringify(failed), updated_by: actor.id } }).catch(() => {});
        throw error;
      }
    }
    return reserved as PreparedModuleCoverSnapshot;
  }
  const pending = reserved;
  try {
    const state: TargetState = { target: { kind: 'module', id: moduleId }, ownerId: actor.id, canManage: true, shared: true };
    const { image, thumbnail } = await renderCover(actor, state, pending.recipe!);
    const directory = await coverDirectory(true);
    const name = hash([createHash('sha256').update(image).digest('hex'), createHash('sha256').update(thumbnail).digest('hex')]);
    const files = { thumbnail: `${name}-640.webp`, image: `${name}-1280.webp` };
    await publishCoverFile(directory, files.image, image); await publishCoverFile(directory, files.thumbnail, thumbnail);
    const ready: PreparedModuleCoverSnapshot = { ...pending, status: 'ready', files };
    const changed = await prisma.platformSetting.updateMany({ where: { key, value_json: JSON.stringify(pending) },
      data: { value_json: JSON.stringify(ready), updated_by: actor.id } });
    if (changed.count !== 1) throw new ModuleCoverError('自动封面准备状态已变化，请沿原请求核对', 409);
    return ready;
  } catch (error) {
    await prisma.platformSetting.updateMany({ where: { key, value_json: JSON.stringify(pending) },
      data: { value_json: JSON.stringify({ ...pending, status: 'failed', error: '自动封面准备未完成，原候选已保留' }), updated_by: actor.id } }).catch(() => {});
    throw error;
  }
}

/** Read only the actor's original durable preparation; no new lease or selection. */
export async function readModuleCoverSnapshotRequest(user: ImageStudioIdentity, moduleId: string, requestId: string): Promise<ModuleCoverSnapshotRequestResult> {
  if (!validId(moduleId) || !validId(requestId)) throw new ModuleCoverError('保存请求编号无效');
  const actor = await assertStudioActor(user.id);
  if (!await prisma.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: actor.id }, select: { id: true } }))
    throw new ModuleCoverError('原模板工作区已不可用', 404);
  await assertStudioWorkspaceNotDeleted(actor.id, moduleId, prisma);
  const row = await prisma.platformSetting.findUnique({ where: { key: prepareKey(actor.id, moduleId, requestId) }, select: { value_json: true } });
  if (!row) return { intent: 'shared-snapshot', requestId, status: 'not-found' };
  const prepared = parsePreparation(row.value_json, actor.id, moduleId, requestId);
  const status = prepared.status === 'committed' ? 'committed' : prepared.status === 'failed' || prepared.expiresAt <= Date.now() ? 'failed'
    : prepared.status === 'ready' ? 'prepared' : 'preparing';
  return { intent: 'shared-snapshot', requestId, status, ...(status === 'failed' ? { error: '封面准备尚未完成，请沿原模板保存请求核对；原候选已保留' } : {}) };
}

export async function commitPreparedModuleCoverSnapshot(actor: ImageStudioIdentity, prepared: PreparedModuleCoverSnapshot,
  client: SharedStudioClient, transition: ModuleCoverSnapshotCommit) {
  if (prepared.ownerId !== actor.id || prepared.moduleId !== transition.sourceModuleId || prepared.targetPresetId !== transition.targetPresetId
    || prepared.moduleRevision !== transition.sourceBeforeRevision
    || prepared.moduleId === transition.moduleId && prepared.moduleRevision !== transition.beforeRevision || transition.afterRevision !== transition.beforeRevision + 1
    || prepared.operationFingerprint !== transition.operationFingerprint || prepared.fingerprint !== preparationFingerprint(prepared)) throw new ModuleCoverError('自动封面与本次模板保存不一致', 409);
  const key = prepareKey(actor.id, prepared.moduleId, prepared.requestId);
  const row = await client.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  if (!row) throw new ModuleCoverError('自动封面准备记录不存在', 409);
  const current = parsePreparation(row.value_json, actor.id, prepared.moduleId, prepared.requestId);
  if (current.status !== 'ready' || current.fingerprint !== prepared.fingerprint || current.lease !== prepared.lease
    || current.expiresAt <= Date.now() || JSON.stringify(current.files) !== JSON.stringify(prepared.files))
    throw new ModuleCoverError('自动封面准备结果已变化，请核对原请求', 409);
  const workspace = await client.imageStudioModule.findFirst({ where: { id: transition.moduleId, owner_id: actor.id }, select: { revision: true, source_preset_id: true } });
  if (!workspace || workspace.revision !== transition.afterRevision || workspace.source_preset_id !== prepared.targetPresetId
    || await studioPublisherModule(actor.id, prepared.targetPresetId, client) !== transition.moduleId)
    throw new ModuleCoverError('模板工作区版本或创建者已变化，自动封面未提交', 409);
  if (prepared.moduleId !== transition.moduleId) {
    const origin = await client.imageStudioModule.findFirst({ where: { id: prepared.moduleId, owner_id: actor.id }, select: { revision: true } });
    await assertStudioWorkspaceNotDeleted(actor.id, prepared.moduleId, client);
    if (!origin || origin.revision !== prepared.moduleRevision || await studioSharedBinding(actor.id, prepared.moduleId, client))
      throw new ModuleCoverError('原封面来源工作区已变化，本次未保存', 409);
  }
  const state = await targetForPreset(actor, prepared.targetPresetId, client);
  if (!state.canManage || state.ownerId !== actor.id || !state.shared) throw new ModuleCoverError('自动封面目标权限已变化', 409);
  const moduleCover = await readRecord({ kind: 'module', id: prepared.moduleId }, client), existing = await readRecord(state.target, client);
  if ((moduleCover ? hash(moduleCover.raw) : null) !== prepared.moduleCoverHash) throw new ModuleCoverError('工作区封面已变化，本次未保存', 409);
  if (prepared.disposition === 'existing') {
    const preserved = prepared.presetCoverHash ? existing && hash(existing.raw) === prepared.presetCoverHash
      : Boolean(existing && moduleCover && existing.record.ownerId === moduleCover.record.ownerId
        && hash(existing.record.recipe) === hash(moduleCover.record.recipe) && hash(existing.record.files) === hash(moduleCover.record.files));
    if (!preserved) throw new ModuleCoverError('原固定封面已变化，本次未保存', 409);
  } else {
    if (existing) throw new ModuleCoverError('封面已由其他操作保存，本次未覆盖', 409);
    if (prepared.disposition === 'image') {
      const recipe = current.recipe!, sources = await authorizedSources(actor, state, recipe.sources.map(source => source.assetId), client);
      if (sources.some((source, index) => source.version !== recipe.sources[index].version)) throw new ModuleCoverError('自动封面原图已变化', 409);
      if (current.taskId) {
        const task = await client.imageStudioTask.findFirst({ where: { id: current.taskId, module_id: prepared.moduleId,
          owner_id: actor.id, deleted_at: null, asset_id: recipe.sources[0].assetId, AND: [studioOutputTaskWhere] },
          select: { status: true, asset_id: true, usage_json: true } });
        if (!task || !studioTaskHasViewableOutput(task)) throw new ModuleCoverError('自动封面原结果已不可用', 409);
      }
      await assertCoverFilesPresent(current.files!);
      const record: CoverRecord = { version: 1, ownerId: actor.id, target: state.target, revision: 1, requestId: prepared.requestId,
        recipe, updatedAt: new Date().toISOString(), files: current.files! };
      const value_json = JSON.stringify(record);
      await client.platformSetting.create({ data: { key: moduleCoverKey(state.target), value_json, updated_by: actor.id } });
      await client.platformSetting.create({ data: { key: historyKey(state.target, 1), value_json, updated_by: actor.id } });
    }
  }
  const changed = await client.platformSetting.updateMany({ where: { key, value_json: row.value_json },
    data: { value_json: JSON.stringify({ ...current, status: 'committed' }), updated_by: actor.id } });
  if (changed.count !== 1) throw new ModuleCoverError('原封面准备回执已变化，本次未保存', 409);
}

async function writeReceipt(client: SharedStudioClient, key: string, receipt: CoverReceipt) {
  const value_json = JSON.stringify(receipt);
  await client.platformSetting.upsert({ where: { key }, create: { key, value_json, updated_by: receipt.ownerId }, update: { value_json, updated_by: receipt.ownerId } });
}
function validReceipt(value: CoverReceipt, ownerId: string, moduleId: string, requestId: string) {
  if (value.ownerId !== ownerId || value.moduleId !== moduleId || value.requestId !== requestId
    || !['saved', 'pending', 'failed'].includes(value.status) || !['module', 'preset'].includes(value.target?.kind) || !validId(value.target?.id)
    || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !validId(value.lease) || !Number.isFinite(value.expiresAt)) throw new ModuleCoverError('封面保存回执无法确认', 409);
  value.recipe = parseRecipe(value.recipe, true);
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
  const originalState = receipt.target.kind === 'module' && receipt.target.id === moduleId && receipt.status === 'saved'
    ? { target: receipt.target, ownerId: actor.id, canManage: true, shared: false } : state;
  return receiptResult(actor, originalState, receipt, prisma);
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
    const priorRow = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    if (priorRow) {
      const prior = readObject<CoverReceipt>(priorRow.value_json);
      validReceipt(prior, actor.id, moduleId, body.requestId);
      if (!sameTarget(prior.target, body.target) || prior.fingerprint !== fingerprint) throw new ModuleCoverError('同一个保存编号不能提交不同封面', 409);
      if (prior.status === 'saved') {
        const originalState = prior.target.kind === 'module' && prior.target.id === moduleId
          ? { target: prior.target, ownerId: actor.id, canManage: true, shared: false } : state;
        return { state: originalState, prior };
      }
      if (!sameTarget(state.target, body.target)) throw new ModuleCoverError('共享关系已变化，请重新打开封面设置', 409);
      if (prior.status === 'pending' && prior.expiresAt > Date.now()) return { state, prior };
    } else if (recipe.version !== 2) throw new ModuleCoverError('封面已升级为正方形，请刷新页面后重新取景保存；旧裁剪不会自动改动', 428);
    if (!sameTarget(state.target, body.target)) throw new ModuleCoverError('共享关系已变化，请重新打开封面设置', 409);
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

// The approved inventory supplies exact identities. This command never searches
// for a new representative image, edits template text, or creates a publisher.
export const SHARED_COVER_R02_INVENTORY_SHA256 = 'b7aa48980e8a394ba26bd07e3ea0b50a3609f0eb0aa77df751fa7a95823811cd';
export type FrozenSharedCoverItem = {
  presetId: string; ownerId: string; presetRevision: string; moduleId: string; moduleRevision: number;
  bindingMode: 'publisher' | 'legacy-source' | 'unique-legacy-workspace'; sourceKind: 'current-result';
  taskId: string; finishedAt: string; assetId: string; sourceVersion: string; sha256: string;
  bytes: number; width: number; height: number; disposition: 'eligible-frozen-single-image';
};
export type FrozenSharedCoverResult = { requestId: string; status: 'ready' | 'saved' | 'pending' | 'skipped' | 'unknown'; reason?: string };
export const frozenSharedCoverRequestId = (item: Pick<FrozenSharedCoverItem, 'presetId'>) =>
  `cover-r02:${hash([SHARED_COVER_R02_INVENTORY_SHA256, item.presetId]).slice(0, 48)}`;
function frozenRecipe(item: FrozenSharedCoverItem): SnapshotRecipe {
  return { version: 3, layout: 'single', fit: 'contain', output: { width: 1280, height: 1280 },
    sources: [{ assetId: item.assetId, version: item.sourceVersion, crop: { x: 0, y: 0, width: 100, height: 100 } }] };
}
function assertFrozenItem(item: FrozenSharedCoverItem) {
  if (!item || [item.presetId, item.ownerId, item.moduleId, item.taskId, item.assetId].some(id => !validId(id))
    || !['publisher', 'legacy-source', 'unique-legacy-workspace'].includes(item.bindingMode)
    || item.sourceKind !== 'current-result' || item.disposition !== 'eligible-frozen-single-image'
    || !Number.isSafeInteger(item.moduleRevision) || item.moduleRevision < 1
    || !Number.isFinite(Date.parse(item.presetRevision)) || !Number.isFinite(Date.parse(item.finishedAt))
    || !/^[a-f0-9]{64}$/.test(item.sourceVersion) || !/^[a-f0-9]{64}$/.test(item.sha256)
    || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > 40 * 1024 * 1024
    || !Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height) || item.width < 1 || item.height < 1
    || item.width * item.height > 40_000_000) throw new ModuleCoverError('冻结清单条目不完整，停止补齐', 409);
}
async function assertFrozenTarget(actor: ImageStudioIdentity, item: FrozenSharedCoverItem, client: SharedStudioClient) {
  const state = await targetForPreset(actor, item.presetId, client);
  const preset = await client.imageStudioPreset.findUniqueOrThrow({ where: { id: item.presetId } });
  if (actor.id !== item.ownerId || state.ownerId !== actor.id || !state.canManage || !state.shared
    || preset.updated_at.toISOString() !== item.presetRevision || await readStudioDeletedSource(actor.id, item.presetId, client))
    throw new ModuleCoverError('模板归属、共享或版本已变化，跳过原清单项', 409);
  const workspace = await client.imageStudioModule.findFirst({ where: { id: item.moduleId, owner_id: actor.id } });
  await assertStudioWorkspaceNotDeleted(actor.id, item.moduleId, client);
  if (!workspace || workspace.revision !== item.moduleRevision || workspace.source_preset_id !== item.presetId)
    throw new ModuleCoverError('原工作区或版本已变化，跳过原清单项', 409);
  const publisher = await studioPublisherModule(actor.id, item.presetId, client);
  const binding = await studioSharedBinding(actor.id, item.moduleId, client);
  if (item.bindingMode === 'publisher') {
    if (publisher !== item.moduleId || binding?.presetId !== item.presetId || binding.mode !== 'publisher')
      throw new ModuleCoverError('原创建者绑定已变化，跳过原清单项', 409);
  } else {
    if (publisher || binding && (binding.presetId !== item.presetId || binding.mode !== 'publisher'))
      throw new ModuleCoverError('历史来源绑定已变化，跳过原清单项', 409);
    if (item.bindingMode === 'legacy-source') {
      if (item.presetId !== `module-source:${item.moduleId}`) throw new ModuleCoverError('历史原工作区无法对应，跳过原清单项', 409);
    } else {
      const candidates = await client.imageStudioModule.findMany({ where: { owner_id: actor.id, source_preset_id: item.presetId }, select: { id: true } });
      if (item.presetId.startsWith('module-source:') || candidates.length !== 1 || candidates[0].id !== item.moduleId)
        throw new ModuleCoverError('历史来源不再唯一，跳过原清单项', 409);
    }
  }
  if (await readRecord(state.target, client) || await readRecord({ kind: 'module', id: item.moduleId }, client))
    throw new ModuleCoverError('已有固定封面，保留原封面并跳过', 409);
  const task = await client.imageStudioTask.findFirst({ where: { id: item.taskId, module_id: item.moduleId, owner_id: actor.id,
    asset_id: item.assetId, deleted_at: null, finished_at: new Date(item.finishedAt), AND: [studioOutputTaskWhere] },
    select: { status: true, asset_id: true, usage_json: true } });
  if (!task || !studioTaskHasViewableOutput(task)) throw new ModuleCoverError('冻结原结果已不可用，跳过原清单项', 409);
  try {
    const [source] = await authorizedSources(actor, state, [item.assetId], client);
    if (source.version !== item.sourceVersion) throw new ModuleCoverError('冻结原图版本已变化，跳过原清单项', 409);
    return { state, asset: source.asset };
  } catch (error) {
    if (['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code || ''))
      throw new ModuleCoverError('冻结原图已不可读取，跳过原清单项', 409);
    throw error;
  }
}
async function assertFrozenBytes(asset: Asset, item: FrozenSharedCoverItem) {
  try {
    const before = await sourceVersion(asset);
    const bytes = await readStudioImage(asset.original_url, AbortSignal.timeout(30000));
    if (before !== item.sourceVersion || bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
      throw new ModuleCoverError('冻结原图字节已变化，跳过原清单项', 409);
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' }).metadata();
    if (metadata.width !== item.width || metadata.height !== item.height || (metadata.pages ?? 1) > 1)
      throw new ModuleCoverError('冻结原图尺寸已变化，跳过原清单项', 409);
    await sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' }).timeout({ seconds: 30 }).stats();
    if (await sourceVersion(asset) !== before) throw new ModuleCoverError('冻结原图读取时发生变化，跳过原清单项', 409);
  } catch (error) {
    if (error instanceof ModuleCoverError) throw error;
    throw new ModuleCoverError('冻结原图暂不可完整读取，跳过原清单项', 409);
  }
}
async function frozenReceipt(actor: ImageStudioIdentity, item: FrozenSharedCoverItem, fingerprint: string, client: SharedStudioClient) {
  const requestId = frozenSharedCoverRequestId(item), key = requestKey(actor.id, item.moduleId, requestId);
  const row = await client.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  if (!row) return null;
  const receipt = readObject<CoverReceipt>(row.value_json);
  validReceipt(receipt, actor.id, item.moduleId, requestId);
  if (receipt.fingerprint !== fingerprint || !sameTarget(receipt.target, { kind: 'preset', id: item.presetId })
    || hash(receipt.recipe) !== hash(frozenRecipe(item))) throw new ModuleCoverError('原补齐回执与冻结清单不一致，停止本项', 409);
  return { receipt, raw: row.value_json, key };
}
/** Default is read-only. Only the separately approved inventory CLI passes apply. */
export async function recoverFrozenSharedCover(user: ImageStudioIdentity, item: FrozenSharedCoverItem,
  inventorySha256: string, apply = false): Promise<FrozenSharedCoverResult> {
  if (inventorySha256 !== SHARED_COVER_R02_INVENTORY_SHA256) throw new ModuleCoverError('不是已批准的 R02 原清单，停止补齐', 409);
  assertFrozenItem(item);
  const actor = await assertStudioActor(user.id);
  if (actor.id !== item.ownerId || actor.account_type !== 'internal' || actor.role !== 'admin')
    throw new ModuleCoverError('授权作者与清单归属不一致，停止补齐', 403);
  const requestId = frozenSharedCoverRequestId(item), key = requestKey(actor.id, item.moduleId, requestId);
  const fingerprint = hash(['frozen-shared-cover-r02', inventorySha256, item]);
  let pending: CoverReceipt | undefined;
  try {
    // Original success is evidence even if the template has changed since then.
    const original = await frozenReceipt(actor, item, fingerprint, prisma);
    if (original?.receipt.status === 'saved') return { requestId, status: 'saved' };
    if (original?.receipt.status === 'pending' && original.receipt.expiresAt > Date.now())
      return { requestId, status: 'pending', reason: '原请求仍在处理，只核对原号，不另开请求' };
    const checked = await assertFrozenTarget(actor, item, prisma);
    await assertFrozenBytes(checked.asset, item);
    if (!apply) return { requestId, status: 'ready' };
    // This operational command must never treat a system-disk storage directory
    // as a production data disk, even when NODE_ENV was omitted by the operator.
    const [root, data] = await Promise.all([fs.realpath(path.join(process.cwd(), 'storage')), fs.realpath('/data')]);
    const [rootStat, dataStat, systemStat] = await Promise.all([fs.stat(root), fs.stat(data), fs.stat('/')]);
    if (!root.startsWith(`${data}${path.sep}`) || rootStat.dev !== dataStat.dev || dataStat.dev === systemStat.dev)
      throw new ModuleCoverError('封面存储未连接真实数据盘，停止补齐', 503);
    const reserved = await prisma.$transaction(async tx => {
      const fresh = await assertStudioActor(actor.id, tx);
      const prior = await frozenReceipt(fresh, item, fingerprint, tx);
      if (prior?.receipt.status === 'saved' || prior?.receipt.status === 'pending' && prior.receipt.expiresAt > Date.now()) return { prior: prior.receipt };
      await assertFrozenTarget(fresh, item, tx);
      const receipt: CoverReceipt = { ownerId: actor.id, moduleId: item.moduleId, requestId, target: { kind: 'preset', id: item.presetId },
        fingerprint, recipe: frozenRecipe(item), status: 'pending', lease: randomUUID(), expiresAt: Date.now() + 180000 };
      if (prior) {
        const changed = await tx.platformSetting.updateMany({ where: { key, value_json: prior.raw }, data: { value_json: JSON.stringify(receipt), updated_by: actor.id } });
        if (changed.count !== 1) throw new ModuleCoverError('原补齐请求正在接续，请核对原号', 409);
      } else await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(receipt), updated_by: actor.id } });
      return { receipt };
    }, { timeout: 15000 });
    if (reserved.prior) return { requestId, status: reserved.prior.status === 'saved' ? 'saved' : 'pending' };
    pending = reserved.receipt!;
    const directory = await coverDirectory(true), rendered = await renderCover(actor, checked.state, pending.recipe);
    await assertFrozenBytes(checked.asset, item);
    const name = hash([createHash('sha256').update(rendered.image).digest('hex'), createHash('sha256').update(rendered.thumbnail).digest('hex')]);
    const files = { thumbnail: `${name}-640.webp`, image: `${name}-1280.webp` };
    await publishCoverFile(directory, files.image, rendered.image); await publishCoverFile(directory, files.thumbnail, rendered.thumbnail);
    await prisma.$transaction(async tx => {
      const fresh = await assertStudioActor(actor.id, tx), prior = await frozenReceipt(fresh, item, fingerprint, tx);
      if (!prior || prior.receipt.status !== 'pending' || prior.receipt.lease !== pending!.lease || prior.receipt.expiresAt <= Date.now())
        throw new ModuleCoverError('原补齐准备状态已变化，请核对原号', 409);
      const { state } = await assertFrozenTarget(fresh, item, tx);
      await assertCoverFilesPresent(files);
      const record: CoverRecord = { version: 1, ownerId: actor.id, target: state.target, revision: 1, requestId,
        recipe: pending!.recipe, updatedAt: new Date().toISOString(), files };
      const value_json = JSON.stringify(record);
      await tx.platformSetting.create({ data: { key: moduleCoverKey(state.target), value_json, updated_by: actor.id } });
      await tx.platformSetting.create({ data: { key: historyKey(state.target, 1), value_json, updated_by: actor.id } });
      const changed = await tx.platformSetting.updateMany({ where: { key, value_json: prior.raw },
        data: { value_json: JSON.stringify({ ...prior.receipt, status: 'saved', record }), updated_by: actor.id } });
      if (changed.count !== 1) throw new ModuleCoverError('原补齐回执同时变化，本项未提交', 409);
    }, { timeout: 15000 });
    return { requestId, status: 'saved' };
  } catch (error) {
    // A transport failure after COMMIT is not rejection. Query the original
    // receipt first; never overwrite a saved receipt or another lease.
    try {
      const observed = await frozenReceipt(actor, item, fingerprint, prisma);
      if (observed?.receipt.status === 'saved') return { requestId, status: 'saved' };
      if (pending && (error instanceof ModuleCoverError || error instanceof StudioSharingError)) await prisma.platformSetting.updateMany({ where: { key, value_json: JSON.stringify(pending) },
        data: { value_json: JSON.stringify({ ...pending, status: 'failed', error: error.message }), updated_by: actor.id } });
    } catch { return { requestId, status: 'unknown', reason: '原补齐结果暂无法核对，请保留原号；不要新建请求' }; }
    return (error instanceof ModuleCoverError || error instanceof StudioSharingError) && error.status < 500
      ? { requestId, status: 'skipped', reason: error.message }
      : { requestId, status: 'unknown', reason: '原补齐未确认，请先核对原号；冻结候选与现有封面保留' };
  }
}
