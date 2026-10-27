import 'server-only';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { getImageStudioSettings, IMAGE_STUDIO_SETTING_KEY, saveImageStudioSettingsInTx } from './settings';
import { privateFieldOrigins } from '@/lib/security/private-prompt-fields.server';
import { requirePrivatePromptRequest } from '@/lib/security/private-prompt-request.server';
import { openPrivatePrompt, sealPrivatePrompt, privatePromptIndex, PrivatePromptError } from '@/lib/security/private-prompts.server';
import { readPrivatePromptDraft, savePrivatePromptDraft, readPrivatePromptDraftReceipt, markPrivatePromptDraftApplied,
  PrivateDraftConflict } from '@/lib/security/private-prompt-drafts.server';

type Client = Pick<Prisma.TransactionClient, 'platformSetting'>;
type Result = { state: 'saved' | 'not-applied'; requestId: string; revision: number };
async function target(userId: string, client: Client = prisma) {
  const settings = await getImageStudioSettings(client);
  const origins = privateFieldOrigins(settings, 'context');
  if (!origins.length) throw new PrivatePromptError();
  await requirePrivatePromptRequest(userId, origins);
  return { settings, draftTarget: { kind: 'image-global', id: IMAGE_STUDIO_SETTING_KEY, origins, fields: ['prompt', 'context'] } };
}
function receiptScope(userId: string, requestId: string, origins: Awaited<ReturnType<typeof target>>['draftTarget']['origins']) {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new PrivatePromptError();
  const key = `private_global_editor_receipt_v1:${privatePromptIndex('private-global-request', JSON.stringify([userId, requestId]))}`;
  return { key, binding: { kind: 'private-global-editor-receipt', id: key, field: 'payload', origins } };
}
async function receipt(client: Client, scope: ReturnType<typeof receiptScope>, requestId: string) {
  const row = await client.platformSetting.findUnique({ where: { key: scope.key }, select: { value_json: true } });
  if (!row) return null;
  const value = JSON.parse(openPrivatePrompt(row.value_json, scope.binding)) as { fingerprint: string; result: Result };
  if (!value || typeof value.fingerprint !== 'string' || !value.result || value.result.requestId !== requestId
    || !['saved', 'not-applied'].includes(value.result.state) || !Number.isSafeInteger(value.result.revision)
    || value.result.revision < 0) throw new PrivatePromptError();
  return value;
}
export async function readPrivateGlobalEditor(userId: string) {
  const { settings, draftTarget } = await target(userId);
  return { revision: settings.revision, sourceRevision: String(settings.revision), prompt: '', context: settings.context,
    draft: await readPrivatePromptDraft(userId, draftTarget) };
}
export async function savePrivateGlobalDraft(userId: string, input: Parameters<typeof savePrivatePromptDraft>[2]) {
  const { draftTarget } = await target(userId);
  if (input.values?.prompt !== '') throw new PrivatePromptError();
  return savePrivatePromptDraft(userId, draftTarget, input);
}
export async function privateGlobalEditorStatus(userId: string, requestId: string, draft: boolean) {
  const { draftTarget } = await target(userId);
  if (draft) return { requestId, draft: await readPrivatePromptDraftReceipt(userId, draftTarget, requestId) };
  return (await receipt(prisma, receiptScope(userId, requestId, draftTarget.origins), requestId))?.result
    ?? { requestId, state: 'unknown' };
}
export async function savePrivateGlobalEditor(userId: string, input: {
  requestId: string; revision: number; sourceRevision: string; prompt: string; context: string; confirmContextClear?: boolean;
}) {
  if (!input || input.prompt !== '' || typeof input.context !== 'string' || input.context.length > 20000
    || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.sourceRevision !== String(input.revision)) throw new PrivatePromptError();
  return prisma.$transaction(async tx => {
    const { settings, draftTarget } = await target(userId, tx);
    const scope = receiptScope(userId, input.requestId, draftTarget.origins);
    const fingerprint = privatePromptIndex('private-global-editor-save', JSON.stringify([input.revision, input.context]));
    const prior = await receipt(tx, scope, input.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new PrivateDraftConflict();
      return prior.result;
    }
    let result: Result = { requestId: input.requestId, state: 'not-applied', revision: settings.revision };
    if (settings.revision === input.revision) {
      const saved = await saveImageStudioSettingsInTx(tx, { ...settings, context: input.context }, userId,
        { privatePromptEdit: true, confirmContextClear: input.confirmContextClear === true });
      if (!saved) throw new PrivateDraftConflict();
      await markPrivatePromptDraftApplied(tx, userId, draftTarget, input.sourceRevision, { prompt: '', context: input.context }, input.requestId);
      result = { requestId: input.requestId, state: 'saved', revision: saved.revision };
    }
    await tx.platformSetting.create({ data: { key: scope.key,
      value_json: sealPrivatePrompt(JSON.stringify({ fingerprint, result }), scope.binding), updated_by: userId } });
    return result;
  });
}
