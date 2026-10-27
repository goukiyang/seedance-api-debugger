import 'server-only';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { readPrivateVideoRecipe, writePrivateVideoRecipe, videoTemplateOrigins } from './private-storage.server';
import { StudioError } from './errors';
import { privateFieldOrigins } from '@/lib/security/private-prompt-fields.server';
import { requirePrivatePromptRequest } from '@/lib/security/private-prompt-request.server';
import { openPrivatePrompt, sealPrivatePrompt, privatePromptIndex, PrivatePromptError } from '@/lib/security/private-prompts.server';
import { readPrivatePromptDraft, savePrivatePromptDraft, readPrivatePromptDraftReceipt, markPrivatePromptDraftApplied,
  PrivateDraftConflict } from '@/lib/security/private-prompt-drafts.server';

type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'videoStudioTemplate'>;
type Result = { state: 'saved' | 'not-applied'; requestId: string; revision: number };
async function target(user: SessionUser, id: string, client: Client = prisma) {
  const row = await client.videoStudioTemplate.findUnique({ where: { id } });
  if (!row || row.owner_user_id !== user.id && user.role !== 'admin') throw new StudioError('模板不存在或无权访问', 404, 'NOT_FOUND');
  const recipe = readPrivateVideoRecipe(row.recipe_json, 'video-template', id, videoTemplateOrigins(id, row.owner_user_id));
  const origins = privateFieldOrigins(recipe, 'instruction');
  if (!origins.length) throw new PrivatePromptError();
  await requirePrivatePromptRequest(user.id, origins);
  return { row, recipe, draftTarget: { kind: 'video-template', id, origins, fields: ['prompt', 'context'] } };
}
function receiptScope(userId: string, id: string, requestId: string, origins: Awaited<ReturnType<typeof target>>['draftTarget']['origins']) {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new PrivatePromptError();
  const key = `private_video_template_receipt_v1:${privatePromptIndex('private-video-template-request', JSON.stringify([userId, id, requestId]))}`;
  return { key, binding: { kind: 'private-video-template-receipt', id: key, field: 'payload', origins } };
}
async function receipt(client: Client, scope: ReturnType<typeof receiptScope>, requestId: string) {
  const row = await client.platformSetting.findUnique({ where: { key: scope.key }, select: { value_json: true } });
  if (!row) return null;
  const value = JSON.parse(openPrivatePrompt(row.value_json, scope.binding)) as { fingerprint: string; result: Result };
  if (!value || Object.keys(value).sort().join(',') !== 'fingerprint,result' || typeof value.fingerprint !== 'string'
    || !value.result || Object.keys(value.result).sort().join(',') !== 'requestId,revision,state'
    || value.result.requestId !== requestId || !['saved', 'not-applied'].includes(value.result.state)
    || !Number.isSafeInteger(value.result.revision) || value.result.revision < 1) throw new PrivatePromptError();
  return value;
}
export async function readPrivateTemplateEditor(user: SessionUser, id: string) {
  const { row, recipe, draftTarget } = await target(user, id);
  return { revision: row.revision, sourceRevision: String(row.revision), prompt: '', context: recipe.instruction,
    draft: await readPrivatePromptDraft(user.id, draftTarget) };
}
export async function savePrivateTemplateDraft(user: SessionUser, id: string, input: Parameters<typeof savePrivatePromptDraft>[2]) {
  const { draftTarget } = await target(user, id);
  if (input.values?.prompt !== '' || typeof input.values?.context !== 'string' || input.values.context.length > 5000) throw new PrivatePromptError();
  return savePrivatePromptDraft(user.id, draftTarget, input);
}
export async function privateTemplateEditorStatus(user: SessionUser, id: string, requestId: string, draft: boolean) {
  const { draftTarget } = await target(user, id);
  if (draft) return { requestId, draft: await readPrivatePromptDraftReceipt(user.id, draftTarget, requestId) };
  return (await receipt(prisma, receiptScope(user.id, id, requestId, draftTarget.origins), requestId))?.result
    ?? { requestId, state: 'unknown' };
}
export async function savePrivateTemplateEditor(user: SessionUser, id: string, input: {
  requestId: string; revision: number; sourceRevision: string; prompt: string; context: string;
}) {
  if (!input || input.prompt !== '' || typeof input.context !== 'string' || !input.context.trim() || input.context.length > 5000
    || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.sourceRevision !== String(input.revision)) throw new PrivatePromptError();
  return prisma.$transaction(async tx => {
    const { row, recipe, draftTarget } = await target(user, id, tx);
    const scope = receiptScope(user.id, id, input.requestId, draftTarget.origins);
    const fingerprint = privatePromptIndex('private-video-template-save', JSON.stringify([input.revision, input.context]));
    const prior = await receipt(tx, scope, input.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new PrivateDraftConflict();
      return prior.result;
    }
    let result: Result = { requestId: input.requestId, state: 'not-applied', revision: row.revision };
    if (row.revision === input.revision) {
      const recipe_json = writePrivateVideoRecipe({ ...recipe, instruction: input.context }, 'video-template', id, draftTarget.origins);
      const changed = await tx.videoStudioTemplate.updateMany({ where: { id, revision: row.revision, recipe_json: row.recipe_json },
        data: { recipe_json, revision: { increment: 1 }, updated_at: new Date() } });
      if (changed.count !== 1) throw new PrivateDraftConflict();
      await markPrivatePromptDraftApplied(tx, user.id, draftTarget, input.sourceRevision, { prompt: '', context: input.context }, input.requestId);
      result = { requestId: input.requestId, state: 'saved', revision: row.revision + 1 };
    }
    await tx.platformSetting.create({ data: { key: scope.key,
      value_json: sealPrivatePrompt(JSON.stringify({ fingerprint, result }), scope.binding), updated_by: user.id } });
    return result;
  });
}
