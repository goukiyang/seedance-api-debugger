import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isSeedanceVideoDuration, isSeedanceVideoModelId } from '@/lib/provider/seedance-models';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS } from '@/types';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import { MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX } from './multiview-recipe-storage.server';
import { composeMultiviewGenerationPrompt, isMultiviewGenerationSeed, isMultiviewPresetVersion, MULTIVIEW_ROTATION_PRESET,
  publicMultiviewRotationPreset,
  type MultiviewRotationPreset, type MultiviewRotationPresetState,
  type MultiviewRotationPresetPublicState, type MultiviewRotationPresetSaveReceipt } from './multiview-generation-contract';

type Db = Prisma.TransactionClient | typeof prisma;
const CURRENT_KEY = 'multiview_rotation_preset_v1:current';
const VERSION_KEY_PREFIX = 'multiview_rotation_preset_v1:version:';
const SAVE_ACTION = 'multiview_rotation_preset_save';
const PRIVATE_INSTALL_SCHEMA = 'multiview-private-recipe-install.v1';
export const MULTIVIEW_OUTPUT_REGISTRATION_ACTIVATION_KEY = 'multiview_output_registration_v1:activation';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptId = (actorId: string, mutationId: string) => `multiview-preset-save-${digest(JSON.stringify([actorId, mutationId]))}`;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

export type MultiviewPrivateRecipeInstallInput = {
  sourceTaskId: string;
  expectedRevision: number;
  mutationId: string;
  prompt: string;
  expectedPromptSha256: string;
  defaults: MultiviewRotationPreset['defaults'];
  compositionReference: MultiviewRotationPreset['compositionReference'];
  guide: { sha256: string; size: number; width: number; height: number };
};
export type MultiviewPrivateRecipeInstallReceipt = {
  schema: typeof PRIVATE_INSTALL_SCHEMA;
  state: 'installed';
  mutationId: string;
  revision: number;
  version: string;
  requestHash: string;
  activatedAt: string;
  activationCreated: boolean;
  sourceTaskMatched: true;
  guideMatched: true;
};

export class MultiviewPresetError extends Error {
  constructor(message: string, public status = 400, public code = 'MULTIVIEW_PRESET_INVALID') { super(message); }
}
const unreadable = () => new MultiviewPresetError('模板提示词暂时无法确认，已有输入保留，请稍后重新读取。', 503, 'MULTIVIEW_PRESET_UNAVAILABLE');
export const MULTIVIEW_PRESET_CHANGED_MESSAGE = '模板提示词已更新，原输入已保留；请重新读取当前模板并确认报价后再生成。';
const changed = () => new MultiviewPresetError(MULTIVIEW_PRESET_CHANGED_MESSAGE, 409, 'MULTIVIEW_PRESET_CHANGED');

function parseState(raw: string): MultiviewRotationPresetState {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unreadable(); }
  if (!record(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !record(value.preset)) throw unreadable();
  const revision = Number(value.revision), preset = value.preset;
  if (!only(preset, ['id', 'version', 'prompt', 'defaults', 'compositionReference'])
    || preset.id !== MULTIVIEW_ROTATION_PRESET.id || !isMultiviewPresetVersion(preset.version)
    || preset.version !== `1.0.${revision}` || typeof preset.prompt !== 'string' || !preset.prompt.trim()
    || !record(preset.defaults) || !only(preset.defaults, ['provider', 'generationMode', 'model', 'ratio', 'duration', 'resolution', 'seed', 'generateAudio', 'returnLastFrame', 'watermark'])
    || preset.defaults.provider !== 'seedance' || preset.defaults.generationMode !== 'all_in_one_reference'
    || typeof preset.defaults.model !== 'string' || !isSeedanceVideoModelId(preset.defaults.model)
    || !RATIO_OPTIONS.includes(preset.defaults.ratio as never) || !isSeedanceVideoDuration(preset.defaults.duration, preset.defaults.model)
    || !RESOLUTION_OPTIONS.includes(preset.defaults.resolution as never) || !isMultiviewGenerationSeed(preset.defaults.seed)
    || typeof preset.defaults.generateAudio !== 'boolean' || typeof preset.defaults.returnLastFrame !== 'boolean'
    || typeof preset.defaults.watermark !== 'boolean' || !record(preset.compositionReference)
    || !only(preset.compositionReference, ['assetId', 'referenceImageId', 'ownerId', 'sha256'])
    || ![preset.compositionReference.assetId, preset.compositionReference.referenceImageId, preset.compositionReference.ownerId]
      .every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value))
    || typeof preset.compositionReference.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(preset.compositionReference.sha256)) throw unreadable();
  const result = { revision, preset: {
    id: MULTIVIEW_ROTATION_PRESET.id, version: preset.version, prompt: preset.prompt,
    defaults: { ...preset.defaults }, compositionReference: { ...preset.compositionReference },
  } } as MultiviewRotationPresetState;
  if (!composeMultiviewGenerationPrompt('', result.preset.version, result.preset).valid) throw unreadable();
  return result;
}

/** Every revision, including legacy 1.0.0, must be installed as a private immutable row. */
export async function readMultiviewRotationPresetVersion(version: string, db: Db = prisma): Promise<MultiviewRotationPreset> {
  if (!isMultiviewPresetVersion(version)) throw changed();
  const row = await db.platformSetting.findUnique({ where: { key: VERSION_KEY_PREFIX + version }, select: { value_json: true } });
  if (!row) throw changed();
  // Versions saved before defaults/composition reference existed cannot generate; say so instead of a retryable 503.
  const legacy = (() => { try { const p = JSON.parse(row.value_json)?.preset; return record(p) && only(p, ['id', 'version', 'prompt']); } catch { return false; } })();
  if (legacy) throw new MultiviewPresetError(`这份设置基于旧版模板 ${version} 保存，旧模板缺少当前生成所需的默认参数和构图参考，不能直接使用；请改用当前模板，需要时重新保存设置。原输入已保留。`, 409, 'MULTIVIEW_PRESET_LEGACY');
  const state = parseState(row.value_json);
  if (state.preset.version !== version) throw unreadable();
  return state.preset;
}

async function readCurrent(db: Db) {
  const row = await db.platformSetting.findUnique({ where: { key: CURRENT_KEY }, select: { value_json: true } });
  if (!row) throw unreadable();
  const state = parseState(row.value_json);
  const immutable = await readMultiviewRotationPresetVersion(state.preset.version, db);
  if (JSON.stringify(immutable) !== JSON.stringify(state.preset)) throw unreadable();
  return { state, raw: row.value_json };
}
export async function readMultiviewRotationPreset(db: Db = prisma): Promise<MultiviewRotationPresetState> {
  return (await readCurrent(db)).state;
}
export async function readPublicMultiviewRotationPreset(db: Db = prisma): Promise<MultiviewRotationPresetPublicState> {
  const state = await readMultiviewRotationPreset(db);
  return { revision: state.revision, preset: publicMultiviewRotationPreset(state.preset) };
}

/** Called again in the same transaction that creates/funds the new task. */
export async function assertCurrentMultiviewRotationPreset(version: string, db: Db = prisma) {
  const state = await readMultiviewRotationPreset(db);
  if (state.preset.version !== version) throw changed();
  return state;
}

function assertMutationId(mutationId: unknown): asserts mutationId is string {
  if (typeof mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(mutationId)) {
    throw new MultiviewPresetError('保存操作编号无效，请保留输入。');
  }
}

function installRequest(input: MultiviewPrivateRecipeInstallInput) {
  assertMutationId(input.mutationId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(input.sourceTaskId)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || typeof input.prompt !== 'string' || !input.prompt.trim()
    || !/^[a-f0-9]{64}$/.test(input.expectedPromptSha256)
    || !Number.isSafeInteger(input.guide.size) || input.guide.size < 24 || input.guide.size >= 30_000_000
    || !Number.isSafeInteger(input.guide.width) || input.guide.width < 1
    || !Number.isSafeInteger(input.guide.height) || input.guide.height < 1
    || input.guide.width * input.guide.height > 40_000_000
    || input.defaults.seed !== -1
    || input.guide.sha256 !== input.compositionReference.sha256
    || digest(input.prompt) !== input.expectedPromptSha256) {
    throw new MultiviewPresetError('私有配方安装内容无效，未修改当前配置。', 400, 'MULTIVIEW_PRIVATE_INSTALL_INVALID');
  }
  const revision = input.expectedRevision + 1;
  if (!Number.isSafeInteger(revision)) throw new MultiviewPresetError('模板版本已到上限，本次未安装。', 409);
  const preset: MultiviewRotationPreset = { id: MULTIVIEW_ROTATION_PRESET.id, version: `1.0.${revision}`,
    prompt: input.prompt, defaults: { ...input.defaults }, compositionReference: { ...input.compositionReference } };
  const state = parseState(JSON.stringify({ revision, preset }));
  const requestHash = digest(JSON.stringify({ schema: PRIVATE_INSTALL_SCHEMA, sourceTaskId: input.sourceTaskId,
    expectedRevision: input.expectedRevision, mutationId: input.mutationId, expectedPromptSha256: input.expectedPromptSha256,
    defaults: state.preset.defaults, compositionReference: state.preset.compositionReference, guide: input.guide }));
  return { revision, preset: state.preset, requestHash };
}

function parseActivation(raw: string) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unreadable(); }
  if (!record(value) || !only(value, ['schema', 'activatedAt']) || value.schema !== 1 || typeof value.activatedAt !== 'string') throw unreadable();
  const time = Date.parse(value.activatedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value.activatedAt) throw unreadable();
  return { schema: 1 as const, activatedAt: value.activatedAt };
}

function parseInstallCurrent(raw: string | null) {
  if (raw === null) return { revision: 0, raw: null };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unreadable(); }
  if (!record(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !record(value.preset)
    || value.preset.id !== MULTIVIEW_ROTATION_PRESET.id || value.preset.version !== `1.0.${Number(value.revision)}`
    || typeof value.preset.prompt !== 'string' || !value.preset.prompt.trim()) throw unreadable();
  if (Object.prototype.hasOwnProperty.call(value.preset, 'defaults')) parseState(raw);
  else if (!only(value.preset, ['id', 'version', 'prompt'])) throw unreadable();
  return { revision: Number(value.revision), raw };
}

async function readPrivateInstallReceipt(actorId: string, mutationId: string, db: Db) {
  const row = await db.operationLog.findUnique({ where: { id: receiptId(actorId, mutationId) } });
  if (!row) return null;
  let detail: unknown;
  try { detail = JSON.parse(row.detail || '{}'); } catch { throw unreadable(); }
  if (row.operator_id !== actorId || row.action !== SAVE_ACTION || row.target_type !== 'MultiviewRotationPreset'
    || row.target_id !== MULTIVIEW_ROTATION_PRESET.id || !record(detail) || !record(detail.install)) throw unreadable();
  const install = detail.install;
  if (!only(install, ['schema', 'state', 'mutationId', 'revision', 'version', 'requestHash', 'activatedAt', 'activationCreated', 'sourceTaskMatched', 'guideMatched'])
    || install.schema !== PRIVATE_INSTALL_SCHEMA || install.state !== 'installed' || install.mutationId !== mutationId
    || !Number.isSafeInteger(install.revision) || Number(install.revision) < 1 || install.version !== `1.0.${Number(install.revision)}`
    || typeof install.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(install.requestHash)
    || typeof install.activatedAt !== 'string' || !Number.isFinite(Date.parse(install.activatedAt))
    || new Date(Date.parse(install.activatedAt)).toISOString() !== install.activatedAt
    || typeof install.activationCreated !== 'boolean' || install.sourceTaskMatched !== true || install.guideMatched !== true) throw unreadable();
  return install as MultiviewPrivateRecipeInstallReceipt;
}

function parsePrivateMediaAccess(raw: string, expected: { assetId: string; ownerId: string; sha256: string }) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unreadable(); }
  if (!record(value) || !only(value, ['schema', 'kind', 'assetId', 'ownerId', 'sha256', 'urls'])
    || value.schema !== 1 || value.kind !== 'system-reference' || value.assetId !== expected.assetId
    || value.ownerId !== expected.ownerId || value.sha256 !== expected.sha256 || !Array.isArray(value.urls) || !value.urls.length
    || value.urls.some(url => typeof url !== 'string' || !siteUploadPathFromUrl(url))) throw unreadable();
  return value.urls as string[];
}

/** Internal deployment primitive. It is intentionally not reachable from an HTTP route. */
export async function installMultiviewPrivateRecipe(input: MultiviewPrivateRecipeInstallInput): Promise<MultiviewPrivateRecipeInstallReceipt> {
  const request = installRequest(input);
  const actorId = request.preset.compositionReference.ownerId;
  const replay = async (db: Db) => {
    const found = await readPrivateInstallReceipt(actorId, input.mutationId, db);
    if (!found) return null;
    if (found.requestHash !== request.requestHash || found.revision !== request.revision || found.version !== request.preset.version) {
      throw new MultiviewPresetError('安装操作编号已用于不同内容，原结果未覆盖。', 409, 'MULTIVIEW_PRIVATE_INSTALL_MUTATION_CONFLICT');
    }
    return found;
  };
  const prior = await replay(prisma);
  if (prior) return prior;
  try {
    return await prisma.$transaction(async db => {
      const saved = await replay(db);
      if (saved) return saved;
      const [actor, task, asset, reference, aliases, currentRow, activationRow, accessRow] = await Promise.all([
        db.user.findUnique({ where: { id: actorId }, select: { id: true, role: true, account_type: true, status: true } }),
        db.videoTask.findUnique({ where: { id: input.sourceTaskId }, select: {
          id: true, prompt: true, final_prompt_snapshot: true, owner_user_id: true, user_id: true,
        } }),
        db.asset.findUnique({ where: { id: request.preset.compositionReference.assetId }, select: {
          id: true, owner_id: true, type: true, original_url: true, thumbnail_url: true, mime_type: true,
          width: true, height: true, file_size: true, hash: true, status: true,
        } }),
        db.referenceImage.findUnique({ where: { id: request.preset.compositionReference.referenceImageId }, select: {
          id: true, asset_id: true, owner_user_id: true, status: true, url: true, thumbnail_url: true,
        } }),
        db.referenceImage.findMany({ where: { asset_id: request.preset.compositionReference.assetId }, select: { url: true, thumbnail_url: true } }),
        db.platformSetting.findUnique({ where: { key: CURRENT_KEY }, select: { value_json: true } }),
        db.platformSetting.findUnique({ where: { key: MULTIVIEW_OUTPUT_REGISTRATION_ACTIVATION_KEY }, select: { value_json: true } }),
        db.platformSetting.findUnique({ where: { key: MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX + input.guide.sha256 }, select: { value_json: true } }),
      ]);
      if (!actor || actor.role !== 'admin' || actor.account_type !== 'internal' || actor.status !== 'active') {
        throw new MultiviewPresetError('私有配方管理员身份无效，未修改当前配置。', 403, 'MULTIVIEW_PRIVATE_INSTALL_ACTOR_INVALID');
      }
      if (!task || (task.owner_user_id || task.user_id) !== actorId
        || task.prompt !== input.prompt || task.final_prompt_snapshot !== input.prompt
        || digest(task.prompt) !== input.expectedPromptSha256 || digest(task.final_prompt_snapshot) !== input.expectedPromptSha256) {
        throw new MultiviewPresetError('原任务提示词与安装内容不一致，未修改当前配置。', 409, 'MULTIVIEW_PRIVATE_INSTALL_SOURCE_MISMATCH');
      }
      const binding = request.preset.compositionReference;
      if (!asset || asset.id !== binding.assetId || asset.owner_id !== binding.ownerId || asset.status !== 'active'
        || asset.type !== 'image' || asset.mime_type !== 'image/png' || asset.hash !== binding.sha256
        || asset.file_size !== input.guide.size || asset.width !== input.guide.width || asset.height !== input.guide.height
        || !reference || reference.id !== binding.referenceImageId || reference.asset_id !== binding.assetId
        || reference.owner_user_id !== binding.ownerId || reference.status !== 'active') {
        throw new MultiviewPresetError('原任务参考图与安装内容不一致，未修改当前配置。', 409, 'MULTIVIEW_PRIVATE_INSTALL_GUIDE_MISMATCH');
      }
      const current = parseInstallCurrent(currentRow?.value_json ?? null);
      if (current.revision !== input.expectedRevision) {
        throw new MultiviewPresetError('模板提示词已更新，本次安装未覆盖。', 409, 'MULTIVIEW_PRESET_REVISION_CONFLICT');
      }
      const actualAliases = [asset.original_url, asset.thumbnail_url, reference.url, reference.thumbnail_url,
        ...aliases.flatMap(item => [item.url, item.thumbnail_url])].filter((url): url is string => Boolean(url && siteUploadPathFromUrl(url)));
      const protectedUrls = new Set<string>();
      for (const url of actualAliases) { protectedUrls.add(url); protectedUrls.add(siteUploadPathFromUrl(url)!); }
      if (!protectedUrls.size) throw unreadable();
      if (accessRow) for (const url of parsePrivateMediaAccess(accessRow.value_json, binding)) protectedUrls.add(url);
      const accessValue = JSON.stringify({ schema: 1, kind: 'system-reference', assetId: binding.assetId,
        ownerId: binding.ownerId, sha256: binding.sha256, urls: Array.from(protectedUrls).sort() });
      const activatedAt = activationRow ? parseActivation(activationRow.value_json).activatedAt : new Date().toISOString();
      const raw = JSON.stringify({ revision: request.revision, preset: request.preset });
      await db.platformSetting.create({ data: { key: VERSION_KEY_PREFIX + request.preset.version, value_json: raw, updated_by: actorId } });
      if (current.raw === null) await db.platformSetting.create({ data: { key: CURRENT_KEY, value_json: raw, updated_by: actorId } });
      else {
        const updated = await db.platformSetting.updateMany({ where: { key: CURRENT_KEY, value_json: current.raw }, data: { value_json: raw, updated_by: actorId } });
        if (updated.count !== 1) throw new MultiviewPresetError('模板提示词已更新，本次安装未覆盖。', 409, 'MULTIVIEW_PRESET_REVISION_CONFLICT');
      }
      if (!activationRow) await db.platformSetting.create({ data: { key: MULTIVIEW_OUTPUT_REGISTRATION_ACTIVATION_KEY,
        value_json: JSON.stringify({ schema: 1, activatedAt }), updated_by: actorId } });
      if (accessRow) {
        const protectedUpdate = await db.platformSetting.updateMany({ where: { key: MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX + binding.sha256,
          value_json: accessRow.value_json }, data: { value_json: accessValue, updated_by: actorId } });
        if (protectedUpdate.count !== 1) throw new MultiviewPresetError('私有素材保护记录已变化，本次安装未覆盖。', 409, 'MULTIVIEW_PRIVATE_INSTALL_ACCESS_CONFLICT');
      } else await db.platformSetting.create({ data: { key: MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX + binding.sha256,
        value_json: accessValue, updated_by: actorId } });
      const receipt: MultiviewPrivateRecipeInstallReceipt = { schema: PRIVATE_INSTALL_SCHEMA, state: 'installed',
        mutationId: input.mutationId, revision: request.revision, version: request.preset.version,
        requestHash: request.requestHash, activatedAt, activationCreated: !activationRow,
        sourceTaskMatched: true, guideMatched: true };
      const ordinaryReceipt: MultiviewRotationPresetSaveReceipt = { state: 'saved', mutationId: input.mutationId,
        revision: request.revision, preset: request.preset };
      await db.operationLog.create({ data: { id: receiptId(actorId, input.mutationId), operator_id: actorId,
        action: SAVE_ACTION, target_type: 'MultiviewRotationPreset', target_id: request.preset.id,
        detail: JSON.stringify({ previousRevision: input.expectedRevision, requestHash: request.requestHash,
          receipt: ordinaryReceipt, install: receipt }) } });
      return receipt;
    });
  } catch (error) {
    if (error instanceof MultiviewPresetError) throw error;
    const saved = await replay(prisma);
    if (saved) return saved;
    throw new MultiviewPresetError('安装结果待确认，请只查询原安装操作编号，不要重复安装。', 503, 'MULTIVIEW_PRIVATE_INSTALL_UNKNOWN');
  }
}
export async function readMultiviewPresetSaveReceipt(actorId: string, mutationId: string, db: Db = prisma): Promise<{
  requestHash: string; receipt: MultiviewRotationPresetSaveReceipt;
} | null> {
  assertMutationId(mutationId);
  const row = await db.operationLog.findUnique({ where: { id: receiptId(actorId, mutationId) } });
  if (!row) return null;
  if (row.operator_id !== actorId || row.action !== SAVE_ACTION || row.target_type !== 'MultiviewRotationPreset'
    || row.target_id !== MULTIVIEW_ROTATION_PRESET.id) throw unreadable();
  let value: { requestHash?: unknown; receipt?: MultiviewRotationPresetSaveReceipt };
  try { value = JSON.parse(row.detail || '{}'); } catch { throw unreadable(); }
  if (!value || typeof value.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestHash)
    || value.receipt?.state !== 'saved' || value.receipt.mutationId !== mutationId) throw unreadable();
  const state = parseState(JSON.stringify(value.receipt));
  return { requestHash: value.requestHash, receipt: { state: 'saved', mutationId, ...state } };
}

/** Only this preset's current pointer, immutable revision and actor-scoped receipt are written. */
export async function saveMultiviewRotationPreset(input: unknown, actorId: string): Promise<MultiviewRotationPresetSaveReceipt> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MultiviewPresetError('模板提示词保存内容无效。');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !['mutationId', 'expectedRevision', 'prompt'].includes(key))
    || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0
    || typeof body.prompt !== 'string' || !body.prompt.trim()) throw new MultiviewPresetError('模板提示词或保存版本无效，原输入保留。');
  assertMutationId(body.mutationId);
  const mutationId = body.mutationId, prompt = body.prompt, expectedRevision = Number(body.expectedRevision);
  const revision = expectedRevision + 1;
  if (!Number.isSafeInteger(revision)) throw new MultiviewPresetError('模板版本已到上限，本次未保存。', 409);
  const requestHash = digest(JSON.stringify({ expectedRevision, prompt }));
  const replay = async (db: Db) => {
    const found = await readMultiviewPresetSaveReceipt(actorId, mutationId, db);
    if (!found) return null;
    if (found.requestHash !== requestHash) throw new MultiviewPresetError('保存编号已用于不同内容，原保存结果未覆盖。', 409, 'MULTIVIEW_PRESET_MUTATION_CONFLICT');
    return found.receipt;
  };
  const prior = await replay(prisma);
  if (prior) return prior;
  const currentForDefinition = await readCurrent(prisma);
  if (currentForDefinition.state.revision !== expectedRevision) {
    throw new MultiviewPresetError('模板提示词已被其他管理员修改，请重新读取；未覆盖新设置。', 409, 'MULTIVIEW_PRESET_REVISION_CONFLICT');
  }
  const preset: MultiviewRotationPreset = { id: MULTIVIEW_ROTATION_PRESET.id, version: `1.0.${revision}`, prompt,
    defaults: { ...currentForDefinition.state.preset.defaults },
    compositionReference: { ...currentForDefinition.state.preset.compositionReference } };
  const composed = composeMultiviewGenerationPrompt('', preset.version, preset);
  if (!composed.valid) throw new MultiviewPresetError(composed.error || '模板提示词过长，未截断或保存内容。');
  try {
    return await prisma.$transaction(async db => {
      const saved = await replay(db);
      if (saved) return saved;
      const current = await readCurrent(db);
      if (current.state.revision !== expectedRevision) throw new MultiviewPresetError('模板提示词已被其他管理员修改，请重新读取；未覆盖新设置。', 409, 'MULTIVIEW_PRESET_REVISION_CONFLICT');
      const state = { revision, preset };
      const raw = JSON.stringify(state);
      await db.platformSetting.create({ data: { key: VERSION_KEY_PREFIX + preset.version, value_json: raw, updated_by: actorId } });
      const updated = await db.platformSetting.updateMany({ where: { key: CURRENT_KEY, value_json: current.raw }, data: { value_json: raw, updated_by: actorId } });
      if (updated.count !== 1) throw new MultiviewPresetError('模板提示词已更新，请重新读取；本次未覆盖。', 409, 'MULTIVIEW_PRESET_REVISION_CONFLICT');
      const receipt: MultiviewRotationPresetSaveReceipt = { state: 'saved', mutationId, ...state };
      await db.operationLog.create({ data: { id: receiptId(actorId, mutationId), operator_id: actorId,
        action: SAVE_ACTION, target_type: 'MultiviewRotationPreset', target_id: preset.id,
        detail: JSON.stringify({ previousRevision: expectedRevision, requestHash, receipt }) } });
      return receipt;
    });
  } catch (error) {
    if (error instanceof MultiviewPresetError) throw error;
    // A failed response is never permission to blindly create a second save.
    const saved = await replay(prisma);
    if (saved) return saved;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    // These errors reject/roll back this interactive transaction. Only a fresh
    // changed revision proves a concurrent save; network/timeout errors remain unknown.
    if (code === 'P2002' || code === 'P2034') {
      const current = await readMultiviewRotationPreset();
      if (current.revision !== expectedRevision) throw new MultiviewPresetError('模板提示词已被其他管理员修改，请重新读取；未覆盖新设置。', 409, 'MULTIVIEW_PRESET_REVISION_CONFLICT');
    }
    throw new MultiviewPresetError('保存结果待确认，请保留输入并查询原保存操作编号，不要重复保存。', 503, 'MULTIVIEW_PRESET_SAVE_UNKNOWN');
  }
}
