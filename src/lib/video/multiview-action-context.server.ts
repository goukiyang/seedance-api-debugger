import 'server-only';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { privateOrigin, privatePromptState, privatePromptIndex, openPrivatePrompt, sealPrivatePrompt, PrivatePromptError, type PrivateOrigin } from '@/lib/security/private-prompts.server';
import { privatePromptRequestCapabilities, requirePrivatePromptRequest } from '@/lib/security/private-prompt-request.server';
import { readPrivatePromptDraft, savePrivatePromptDraft, readPrivatePromptDraftReceipt, markPrivatePromptDraftApplied, PrivateDraftConflict } from '@/lib/security/private-prompt-drafts.server';
import { StudioError } from '@/lib/template-studio/errors';
import type { MultiviewActionContextKind } from './multiview-action-contract';

type Db = Pick<Prisma.TransactionClient, 'platformSetting'>;
export const MULTIVIEW_ACTION_CONTEXT_KEYS = { format: 'multiview_action_format_v1', sync: 'multiview_action_sync_v1' } as const;
type Setting = { context: string; revision: number };
export function multiviewActionContextOrigins(kind: MultiviewActionContextKind): PrivateOrigin[] {
  const origin = privateOrigin(`multiview-action-${kind}`, MULTIVIEW_ACTION_CONTEXT_KEYS[kind]);
  if (!origin || ['legacy-read', 'compatible-read'].includes(privatePromptState())) throw new PrivatePromptError();
  return [origin];
}
function binding(kind: MultiviewActionContextKind) {
  return { kind: `multiview-action-${kind}`, id: MULTIVIEW_ACTION_CONTEXT_KEYS[kind], field: 'context', origins: multiviewActionContextOrigins(kind) };
}
export async function readMultiviewActionContext(kind: MultiviewActionContextKind, db: Db = prisma): Promise<Setting> {
  const row = await db.platformSetting.findUnique({ where: { key: MULTIVIEW_ACTION_CONTEXT_KEYS[kind] }, select: { value_json: true } });
  if (!row) return { context: '', revision: 0 };
  try {
    const value = JSON.parse(row.value_json);
    if (typeof value.context !== 'string' || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new PrivatePromptError();
    return { context: openPrivatePrompt(value.context, binding(kind)), revision: value.revision };
  } catch { throw new PrivatePromptError(); }
}
function target(kind: MultiviewActionContextKind) {
  return { kind: 'multiview-action-context', id: MULTIVIEW_ACTION_CONTEXT_KEYS[kind], origins: multiviewActionContextOrigins(kind), fields: ['prompt', 'context'] };
}
export async function multiviewActionContextMetadata(user: SessionUser, kind: MultiviewActionContextKind) {
  const setting = await readMultiviewActionContext(kind);
  const capabilities = await privatePromptRequestCapabilities(user.id, multiviewActionContextOrigins(kind));
  return { configured: Boolean(setting.context.trim()), revision: setting.revision, canEdit: user.role === 'admin' && capabilities.canEditPrivatePrompt, ...capabilities };
}
async function editorTarget(user: SessionUser, kind: MultiviewActionContextKind) {
  if (user.role !== 'admin') throw new StudioError('只有管理员可以编辑固定规则', 403, 'FORBIDDEN');
  const draftTarget = target(kind);
  await requirePrivatePromptRequest(user.id, draftTarget.origins);
  return draftTarget;
}
export async function readMultiviewActionContextEditor(user: SessionUser, kind: MultiviewActionContextKind) {
  const draftTarget = await editorTarget(user, kind);
  const setting = await readMultiviewActionContext(kind);
  return { revision: setting.revision, sourceRevision: String(setting.revision), prompt: '', context: setting.context,
    draft: await readPrivatePromptDraft(user.id, draftTarget) };
}
export async function saveMultiviewActionContextDraft(user: SessionUser, kind: MultiviewActionContextKind, input: Parameters<typeof savePrivatePromptDraft>[2]) {
  const draftTarget = await editorTarget(user, kind);
  if (input?.values?.prompt !== '' || typeof input.values.context !== 'string' || input.values.context.length > 12000) throw new PrivatePromptError();
  return savePrivatePromptDraft(user.id, draftTarget, input);
}
function receiptIdentity(userId: string, kind: MultiviewActionContextKind, requestId: string) {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new PrivatePromptError();
  const key = `multiview_action_context_receipt:${privatePromptIndex('multiview-action-context-request', JSON.stringify([userId, kind, requestId]))}`;
  return { key, binding: { kind: 'multiview-action-context-receipt', id: key, field: 'payload', origins: multiviewActionContextOrigins(kind) } };
}
async function readReceipt(db: Db, userId: string, kind: MultiviewActionContextKind, requestId: string) {
  const scope = receiptIdentity(userId, kind, requestId);
  const row = await db.platformSetting.findUnique({ where: { key: scope.key }, select: { value_json: true } });
  if (!row) return null;
  const value = JSON.parse(openPrivatePrompt(row.value_json, scope.binding)) as { fingerprint: string; result: { state: 'saved' | 'not-applied'; requestId: string; revision: number } };
  if (!value || typeof value.fingerprint !== 'string' || !value.result || value.result.requestId !== requestId
    || !['saved', 'not-applied'].includes(value.result.state) || !Number.isSafeInteger(value.result.revision)) throw new PrivatePromptError();
  return value;
}
export async function multiviewActionContextStatus(user: SessionUser, kind: MultiviewActionContextKind, requestId: string, draft: boolean) {
  const draftTarget = await editorTarget(user, kind);
  return draft ? { requestId, draft: await readPrivatePromptDraftReceipt(user.id, draftTarget, requestId) }
    : (await readReceipt(prisma, user.id, kind, requestId))?.result ?? { requestId, state: 'unknown' };
}
export async function saveMultiviewActionContextEditor(user: SessionUser, kind: MultiviewActionContextKind, input: { requestId: string; revision: number; sourceRevision: string; prompt: string; context: string }) {
  const draftTarget = await editorTarget(user, kind);
  if (!input || input.prompt !== '' || typeof input.context !== 'string' || !input.context.trim() || input.context.length > 12000
    || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.sourceRevision !== String(input.revision)) throw new StudioError('固定规则不能为空，最多12000字', 400, 'INVALID');
  return prisma.$transaction(async tx => {
    await editorTarget(user, kind);
    const fingerprint = privatePromptIndex('multiview-action-context-save', JSON.stringify([input.revision, input.context]));
    const prior = await readReceipt(tx, user.id, kind, input.requestId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new PrivateDraftConflict(); return prior.result; }
    const key = MULTIVIEW_ACTION_CONTEXT_KEYS[kind];
    const row = await tx.platformSetting.findUnique({ where: { key } });
    const setting = await readMultiviewActionContext(kind, tx);
    let result: { state: 'saved' | 'not-applied'; requestId: string; revision: number } = { state: 'not-applied', requestId: input.requestId, revision: setting.revision };
    if (setting.revision === input.revision) {
      const revision = setting.revision + 1;
      const value_json = JSON.stringify({ revision, context: sealPrivatePrompt(input.context, binding(kind)) });
      if (row) {
        if ((await tx.platformSetting.updateMany({ where: { key, value_json: row.value_json }, data: { value_json, updated_by: user.id } })).count !== 1) throw new PrivateDraftConflict();
      } else await tx.platformSetting.create({ data: { key, value_json, updated_by: user.id } });
      await markPrivatePromptDraftApplied(tx, user.id, draftTarget, input.sourceRevision, { prompt: '', context: input.context }, input.requestId);
      result = { state: 'saved', requestId: input.requestId, revision };
    }
    const scope = receiptIdentity(user.id, kind, input.requestId);
    await tx.platformSetting.create({ data: { key: scope.key, value_json: sealPrivatePrompt(JSON.stringify({ fingerprint, result }), scope.binding), updated_by: user.id } });
    return result;
  });
}
/** Deployment-only, insert-only initialization. Call with private stdin; never overwrite published settings. */
export async function initializeMultiviewActionContexts(input: { format: string; sync: string }, actorId: string) {
  if (!actorId || typeof input?.format !== 'string' || !input.format.trim() || input.format.length > 12000
    || typeof input.sync !== 'string' || !input.sync.trim() || input.sync.length > 12000) throw new Error('Invalid private initialization input');
  return prisma.$transaction(async tx => {
    const result: Record<string, string> = {};
    for (const kind of ['format', 'sync'] as const) {
      const key = MULTIVIEW_ACTION_CONTEXT_KEYS[kind];
      const previous = await tx.platformSetting.findUnique({ where: { key }, select: { key: true } });
      if (previous) { result[kind] = 'preserved'; continue; }
      await tx.platformSetting.create({ data: { key, value_json: JSON.stringify({ revision: 1, context: sealPrivatePrompt(input[kind], binding(kind)) }), updated_by: actorId } });
      result[kind] = 'initialized';
    }
    return result;
  });
}
