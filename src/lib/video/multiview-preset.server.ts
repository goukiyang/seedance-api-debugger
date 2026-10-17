import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { composeMultiviewGenerationPrompt, isMultiviewPresetVersion, MULTIVIEW_ROTATION_PRESET,
  type MultiviewRotationPreset, type MultiviewRotationPresetState,
  type MultiviewRotationPresetSaveReceipt } from './multiview-generation-contract';

type Db = Prisma.TransactionClient | typeof prisma;
const CURRENT_KEY = 'multiview_rotation_preset_v1:current';
const VERSION_KEY_PREFIX = 'multiview_rotation_preset_v1:version:';
const SAVE_ACTION = 'multiview_rotation_preset_save';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptId = (actorId: string, mutationId: string) => `multiview-preset-save-${digest(JSON.stringify([actorId, mutationId]))}`;
const initialState = (): MultiviewRotationPresetState => ({ revision: 0,
  preset: { id: MULTIVIEW_ROTATION_PRESET.id, version: MULTIVIEW_ROTATION_PRESET.version, prompt: MULTIVIEW_ROTATION_PRESET.prompt } });

export class MultiviewPresetError extends Error {
  constructor(message: string, public status = 400, public code = 'MULTIVIEW_PRESET_INVALID') { super(message); }
}
const unreadable = () => new MultiviewPresetError('模板提示词暂时无法确认，已有输入保留，请稍后重新读取。', 503, 'MULTIVIEW_PRESET_UNAVAILABLE');
export const MULTIVIEW_PRESET_CHANGED_MESSAGE = '模板提示词已更新，原输入已保留；请重新读取当前模板并确认报价后再生成。';
const changed = () => new MultiviewPresetError(MULTIVIEW_PRESET_CHANGED_MESSAGE, 409, 'MULTIVIEW_PRESET_CHANGED');

function parseState(raw: string): MultiviewRotationPresetState {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unreadable(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unreadable();
  const state = value as MultiviewRotationPresetState;
  if (!Number.isSafeInteger(state.revision) || state.revision < 1 || !state.preset
    || state.preset.id !== MULTIVIEW_ROTATION_PRESET.id || !isMultiviewPresetVersion(state.preset.version)
    || state.preset.version !== `1.0.${state.revision}` || typeof state.preset.prompt !== 'string'
    || !state.preset.prompt.trim() || !composeMultiviewGenerationPrompt('', state.preset.version, state.preset).valid) throw unreadable();
  return { revision: state.revision, preset: { id: state.preset.id, version: state.preset.version, prompt: state.preset.prompt } };
}

/** v1.0.0 remains an immutable virtual revision; GET never creates settings. */
export async function readMultiviewRotationPresetVersion(version: string, db: Db = prisma): Promise<MultiviewRotationPreset> {
  if (!isMultiviewPresetVersion(version)) throw changed();
  if (version === MULTIVIEW_ROTATION_PRESET.version) return initialState().preset;
  const row = await db.platformSetting.findUnique({ where: { key: VERSION_KEY_PREFIX + version }, select: { value_json: true } });
  if (!row) throw changed();
  const state = parseState(row.value_json);
  if (state.preset.version !== version) throw unreadable();
  return state.preset;
}

async function readCurrent(db: Db) {
  const row = await db.platformSetting.findUnique({ where: { key: CURRENT_KEY }, select: { value_json: true } });
  if (!row) return { state: initialState(), raw: null };
  const state = parseState(row.value_json);
  const immutable = await readMultiviewRotationPresetVersion(state.preset.version, db);
  if (immutable.prompt !== state.preset.prompt) throw unreadable();
  return { state, raw: row.value_json };
}
export async function readMultiviewRotationPreset(db: Db = prisma): Promise<MultiviewRotationPresetState> {
  return (await readCurrent(db)).state;
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
  const preset: MultiviewRotationPreset = { id: MULTIVIEW_ROTATION_PRESET.id, version: `1.0.${revision}`, prompt };
  const composed = composeMultiviewGenerationPrompt('', preset.version, preset);
  if (!composed.valid) throw new MultiviewPresetError(composed.error || '模板提示词过长，未截断或保存内容。');
  const requestHash = digest(JSON.stringify({ expectedRevision, prompt }));
  const replay = async (db: Db) => {
    const found = await readMultiviewPresetSaveReceipt(actorId, mutationId, db);
    if (!found) return null;
    if (found.requestHash !== requestHash) throw new MultiviewPresetError('保存编号已用于不同内容，原保存结果未覆盖。', 409, 'MULTIVIEW_PRESET_MUTATION_CONFLICT');
    return found.receipt;
  };
  const prior = await replay(prisma);
  if (prior) return prior;
  try {
    return await prisma.$transaction(async db => {
      const saved = await replay(db);
      if (saved) return saved;
      const current = await readCurrent(db);
      if (current.state.revision !== expectedRevision) throw new MultiviewPresetError('模板提示词已被其他管理员修改，请重新读取；未覆盖新设置。', 409, 'MULTIVIEW_PRESET_REVISION_CONFLICT');
      const state = { revision, preset };
      const raw = JSON.stringify(state);
      await db.platformSetting.create({ data: { key: VERSION_KEY_PREFIX + preset.version, value_json: raw, updated_by: actorId } });
      if (current.raw === null) {
        await db.platformSetting.create({ data: { key: CURRENT_KEY, value_json: raw, updated_by: actorId } });
      } else {
        const updated = await db.platformSetting.updateMany({ where: { key: CURRENT_KEY, value_json: current.raw }, data: { value_json: raw, updated_by: actorId } });
        if (updated.count !== 1) throw new MultiviewPresetError('模板提示词已更新，请重新读取；本次未覆盖。', 409, 'MULTIVIEW_PRESET_REVISION_CONFLICT');
      }
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
