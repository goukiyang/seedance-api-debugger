import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { STUDIO_TEXT_MODELS } from '@/lib/template-studio/text-models';
import { getMuskApiSettings } from '@/lib/integrations/musk';
import { MODEL_ACCESS_KEY, parseModelAccessSettings, supplementaryModelEnabled,
  type ModelAccessSettings, type SupplementaryModelKind } from './model-availability-contract';
import { PricingAdminServiceError } from './policy';
import { pricingFingerprint } from './catalog';

type Db = Prisma.TransactionClient;
type Actor = { id: string };
type Operation = { requestId: string; state: 'succeeded' | 'rejected' | 'unknown'; settings: ModelAccessSettings | null; error: string | null };
const action = 'pricing_model_access_save';
export const supplementaryModelChoices = [...STUDIO_TEXT_MODELS.map(model => ({ kind: 'text' as const, model: model.id, label: model.label })),
  { kind: 'cutout' as const, model: 'all', label: '智能抠图（所有模型）' }];
export async function getSupplementaryModelChoices(db: Db | typeof prisma = prisma) {
  const settings = await getMuskApiSettings(db);
  const stored = await readModelAccessSettings(db);
  return [...supplementaryModelChoices, ...Array.from(new Set([settings.default_model, ...settings.allowed_models,
    ...stored.models.filter(item => item.kind === 'text').map(item => item.model)]))
    .filter(model => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)
      && !supplementaryModelChoices.some(choice => choice.kind === 'text' && choice.model === model))
    .map(model => ({ kind: 'text' as const, model, label: model }))];
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new PricingAdminServiceError('保存请求编号无效');
  return value;
}
const receiptId = (actor: Actor, id: string) => `model-access:${createHash('sha256').update(JSON.stringify([actor.id, id])).digest('hex')}`;
async function freshAdmin(actor: Actor, db: Db) {
  const user = await db.user.findUnique({ where: { id: actor.id }, select: { role: true, status: true, expires_at: true } });
  if (!user || user.role !== 'admin' || user.status !== 'active' || user.expires_at && user.expires_at <= new Date()) throw new AuthError('管理员权限已失效', 403);
}
export async function readModelAccessSettings(db: Pick<Db, 'platformSetting'> = prisma) {
  const row = await db.platformSetting.findUnique({ where: { key: MODEL_ACCESS_KEY }, select: { value_json: true } });
  return parseModelAccessSettings(row?.value_json ?? null);
}
/** New admission only. Accepted jobs and original-request lookup must not call this gate. */
export async function assertSupplementaryModelEnabled(kind: SupplementaryModelKind, model: string, db: Pick<Db, 'platformSetting'> = prisma) {
  if (!supplementaryModelEnabled(await readModelAccessSettings(db), kind, model)) {
    throw new AuthError('该模型已在费率页关闭，请选择已开放模型；当前输入已保留', 403);
  }
}
async function receipt(actor: Actor, id: string, db: Db): Promise<{ fingerprint: string; operation: Operation } | null> {
  const row = await db.operationLog.findUnique({ where: { id: receiptId(actor, id) } });
  if (!row) return null;
  const value = JSON.parse(row.detail || '');
  if (row.operator_id !== actor.id || row.action !== action || row.target_type !== 'PlatformSetting' || row.target_id !== MODEL_ACCESS_KEY
    || value.operation?.requestId !== id || !['succeeded', 'rejected'].includes(value.operation?.state)
    || typeof value.fingerprint !== 'string') throw new PricingAdminServiceError('原模型开关回执无法读取，请保留原编号', 503);
  return { fingerprint: value.fingerprint, operation: { ...value.operation,
    settings: value.operation.state === 'succeeded' ? parseModelAccessSettings(JSON.stringify(value.operation.settings)) : null } };
}
export async function getModelAccessOperation(actor: Actor, value: unknown) {
  const id = requestId(value);
  return prisma.$transaction(async db => {
    await freshAdmin(actor, db);
    return { operation: (await receipt(actor, id, db))?.operation ?? { requestId: id, state: 'unknown', settings: null, error: null } };
  });
}
export async function saveModelAccessSettings(actor: Actor, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PricingAdminServiceError('模型开关保存内容无效');
  const body = input as Record<string, unknown>, id = requestId(body.requestId), fingerprint = pricingFingerprint(body);
  const replay = async (db: Db) => {
    const previous = await receipt(actor, id, db);
    if (previous && previous.fingerprint !== fingerprint) throw new PricingAdminServiceError('同一保存编号内容不同，请核对原保存', 409, 'model_access_operation_mismatch');
    return previous?.operation;
  };
  const writeReceipt = (db: Db, operation: Operation) => db.operationLog.create({ data: { id: receiptId(actor, id),
    operator_id: actor.id, action, target_type: 'PlatformSetting', target_id: MODEL_ACCESS_KEY,
    detail: JSON.stringify({ fingerprint, operation }) } });
  try {
    return await prisma.$transaction(async db => {
      await freshAdmin(actor, db);
      const previous = await replay(db);
      if (previous) return { operation: previous };
      if (Object.keys(body).some(key => !['requestId', 'revision', 'settings'].includes(key))) throw new PricingAdminServiceError('模型开关包含未知字段');
      let settings: ModelAccessSettings;
      try { settings = parseModelAccessSettings(JSON.stringify(body.settings)); }
      catch { throw new PricingAdminServiceError('模型开关保存格式无效'); }
      const choices = await getSupplementaryModelChoices(db);
      if (settings.models.some(item => !choices.some(choice => choice.kind === item.kind && choice.model === item.model))) {
        throw new PricingAdminServiceError('模型不在当前可管理目录');
      }
      const row = await db.platformSetting.findUnique({ where: { key: MODEL_ACCESS_KEY } });
      const current = parseModelAccessSettings(row?.value_json ?? null);
      if (current.revision !== body.revision || settings.revision !== body.revision) throw new PricingAdminServiceError('模型开关已变化，请保留草稿重新读取', 409, 'model_access_conflict');
      settings.revision = randomUUID();
      const data = { value_json: JSON.stringify(settings), updated_by: actor.id };
      if (row) {
        const saved = await db.platformSetting.updateMany({ where: { key: MODEL_ACCESS_KEY, value_json: row.value_json }, data });
        if (saved.count !== 1) throw new PricingAdminServiceError('模型开关保存冲突，原设置未覆盖', 409, 'model_access_conflict');
      } else await db.platformSetting.create({ data: { key: MODEL_ACCESS_KEY, ...data } });
      const operation: Operation = { requestId: id, state: 'succeeded', settings, error: null };
      await writeReceipt(db, operation);
      return { operation };
    }, { maxWait: 10000, timeout: 10000 });
  } catch (error) {
    const failure = error instanceof PricingAdminServiceError ? error
      : error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)
        ? new PricingAdminServiceError('模型开关发生并发更新，本次未生效，请重新读取', 409) : null;
    if (!failure || failure.status >= 500 || failure.code === 'model_access_operation_mismatch') throw error;
    return prisma.$transaction(async db => {
      await freshAdmin(actor, db);
      const previous = await replay(db);
      if (previous) return { operation: previous };
      const operation: Operation = { requestId: id, state: 'rejected', settings: null, error: failure.message };
      await writeReceipt(db, operation);
      return { operation };
    });
  }
}
