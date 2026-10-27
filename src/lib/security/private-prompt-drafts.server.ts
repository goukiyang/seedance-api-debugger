import 'server-only';
import { prisma } from '@/lib/prisma';
import { privatePromptIndex, openPrivatePrompt, sealPrivatePrompt, type PrivateOrigin, PrivatePromptError } from './private-prompts.server';
import { requirePrivatePromptRequest } from './private-prompt-request.server';
import type { Prisma } from '@prisma/client';

type DraftTarget = { kind: string; id: string; origins: PrivateOrigin[]; fields: readonly string[] };
type Draft = { version: 1; revision: number; sourceRevision: string; values: Record<string, string>; appliedRequestId?: string };
type Rejected = { state: 'not-applied' };
type Saved = { version: 1; fingerprint: string; draft: Draft | Rejected };
export class PrivateDraftConflict extends Error {
  readonly status = 409;
  constructor() { super('草稿已有更新，当前输入仍保留，请核对后再保存'); }
}
function identity(actorId: string, target: DraftTarget) {
  if (!target.origins.length || !actorId || !target.fields.length || target.fields.some(field => !/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(field))) throw new PrivatePromptError();
  const scope = privatePromptIndex('private-draft-scope', JSON.stringify([actorId, target.kind, target.id]));
  return { key: `private_prompt_draft_v1:${scope}`, binding: { kind: 'private-prompt-draft', id: scope, field: 'payload', origins: target.origins } };
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function validValues(value: unknown, target: DraftTarget): value is Record<string, string> {
  return object(value) && Object.keys(value).length === target.fields.length
    && target.fields.every(field => Object.hasOwn(value, field) && typeof value[field] === 'string' && value[field].length <= 20000);
}
function validateDraft(value: unknown, target: DraftTarget): Draft {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || typeof value.sourceRevision !== 'string' || value.sourceRevision.length > 256 || !validValues(value.values, target)
    || Object.keys(value).some(key => !['version', 'revision', 'sourceRevision', 'values', 'appliedRequestId'].includes(key))
    || (value.appliedRequestId !== undefined && (typeof value.appliedRequestId !== 'string'
      || !/^[A-Za-z0-9:_-]{1,160}$/.test(value.appliedRequestId)))) throw new PrivatePromptError();
  return value as Draft;
}
function decode(raw: string, binding: ReturnType<typeof identity>['binding'], target: DraftTarget): Draft {
  return validateDraft(JSON.parse(openPrivatePrompt(raw, binding)), target);
}
function decodeReceipt(raw: string, binding: ReturnType<typeof identity>['binding'], target: DraftTarget): Saved {
  const saved: unknown = JSON.parse(openPrivatePrompt(raw, binding));
  if (!object(saved) || saved.version !== 1 || typeof saved.fingerprint !== 'string' || !saved.fingerprint
    || Object.keys(saved).some(key => !['version', 'fingerprint', 'draft'].includes(key))) throw new PrivatePromptError();
  if (object(saved.draft) && saved.draft.state === 'not-applied') {
    if (Object.keys(saved.draft).length !== 1) throw new PrivatePromptError();
  } else validateDraft(saved.draft, target);
  return saved as Saved;
}
export async function readPrivatePromptDraft(actorId: string, target: DraftTarget) {
  await requirePrivatePromptRequest(actorId, target.origins);
  const { key, binding } = identity(actorId, target);
  const row = await prisma.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  return row ? decode(row.value_json, binding, target) : null;
}
export async function readPrivatePromptDraftReceipt(actorId: string, target: DraftTarget, requestId: string) {
  await requirePrivatePromptRequest(actorId, target.origins);
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new PrivatePromptError();
  const { binding } = identity(actorId, target);
  const key = `private_prompt_draft_receipt_v1:${privatePromptIndex('private-draft-request', JSON.stringify([actorId, binding.id, requestId]))}`;
  const row = await prisma.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  if (!row) return null;
  const saved = decodeReceipt(row.value_json, { ...binding, kind: 'private-prompt-draft-receipt', id: key }, target);
  return saved.draft;
}
export async function savePrivatePromptDraft(actorId: string, target: DraftTarget, input: {
  expectedRevision: number; sourceRevision: string; requestId: string; values: Record<string, string>;
}) {
  await requirePrivatePromptRequest(actorId, target.origins);
  const { key, binding } = identity(actorId, target);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.sourceRevision !== 'string'
    || input.sourceRevision.length > 256 || !/^[A-Za-z0-9:_-]{1,160}$/.test(input.requestId)
    || !validValues(input.values, target)) throw new PrivatePromptError();
  const fingerprint = privatePromptIndex('private-draft-write', JSON.stringify([binding.id, input.expectedRevision, input.sourceRevision,
    Object.entries(input.values).sort(([a], [b]) => a.localeCompare(b))]));
  const receiptKey = `private_prompt_draft_receipt_v1:${privatePromptIndex('private-draft-request', JSON.stringify([actorId, binding.id, input.requestId]))}`;
  const receiptBinding = { ...binding, kind: 'private-prompt-draft-receipt', id: receiptKey };
  return prisma.$transaction(async tx => {
    const prior = await tx.platformSetting.findUnique({ where: { key: receiptKey }, select: { value_json: true } });
    if (prior) {
      const saved = decodeReceipt(prior.value_json, receiptBinding, target);
      if (saved.fingerprint !== fingerprint) throw new PrivateDraftConflict();
      return saved.draft;
    }
    const current = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    const revision = current ? decode(current.value_json, binding, target).revision : 0;
    if (revision === Number.MAX_SAFE_INTEGER) throw new PrivatePromptError();
    if (revision !== input.expectedRevision) {
      const rejected = { state: 'not-applied' } satisfies Rejected;
      await tx.platformSetting.create({ data: { key: receiptKey, value_json: sealPrivatePrompt(JSON.stringify({ version: 1,
        fingerprint, draft: rejected } satisfies Saved), receiptBinding), updated_by: actorId } });
      return rejected;
    }
    const draft: Draft = { version: 1, revision: revision + 1, sourceRevision: input.sourceRevision, values: input.values };
    const value_json = sealPrivatePrompt(JSON.stringify(draft), binding);
    if (current) {
      if ((await tx.platformSetting.updateMany({ where: { key, value_json: current.value_json }, data: { value_json, updated_by: actorId } })).count !== 1) throw new PrivateDraftConflict();
    } else await tx.platformSetting.create({ data: { key, value_json, updated_by: actorId } });
    await tx.platformSetting.create({ data: { key: receiptKey,
      value_json: sealPrivatePrompt(JSON.stringify({ version: 1, fingerprint, draft } satisfies Saved), receiptBinding), updated_by: actorId } });
    return draft;
  });
}

export async function markPrivatePromptDraftApplied(tx: Pick<Prisma.TransactionClient, 'platformSetting'>, actorId: string,
  target: DraftTarget, sourceRevision: string, values: Record<string, string>, requestId: string) {
  const { key, binding } = identity(actorId, target);
  const row = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  if (!row) return;
  const draft = decode(row.value_json, binding, target);
  if (draft.sourceRevision !== sourceRevision || Object.keys(values).some(field => draft.values[field] !== values[field])) return;
  await tx.platformSetting.updateMany({ where: { key, value_json: row.value_json }, data: {
    value_json: sealPrivatePrompt(JSON.stringify({ ...draft, appliedRequestId: requestId }), binding), updated_by: actorId } });
}
