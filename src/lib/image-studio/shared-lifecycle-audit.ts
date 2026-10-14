import type { Prisma } from '@prisma/client';
import { recordContentAuditLog } from '@/lib/content-audit';
import type { SharedStudioEntryPoint, SharedStudioLifecycleDetail, SharedStudioLifecycleRevisionState } from './shared-types';

type Client = Pick<Prisma.TransactionClient, 'contentAuditLog'>;
type RevisionState = SharedStudioLifecycleRevisionState;
export type StudioLifecycleAction = 'published' | 'definition-saved' | 'definition-renamed' | 'sharing-enabled' | 'sharing-disabled' | 'source-archived' | 'sharing-preference-changed';
export function studioLifecycleEntryPoint(value: unknown): SharedStudioEntryPoint {
  return value === 'template-library' || value === 'workbench' ? value : 'unknown';
}
function state(value: RevisionState | undefined) {
  const safe: RevisionState = {};
  if (!value) return safe;
  if (typeof value.sourceRevision === 'string' || value.sourceRevision === null) safe.sourceRevision = value.sourceRevision;
  if (Number.isSafeInteger(value.moduleRevision) || value.moduleRevision === null) safe.moduleRevision = value.moduleRevision;
  if (typeof value.isShared === 'boolean') safe.isShared = value.isShared;
  return safe;
}
const definitionFields = new Set(['name', 'groupName', 'templatePrompt', 'context', 'globalContext', 'model', 'quality', 'resolution', 'count', 'aspectRatio',
  'referenceLimit', 'referenceIds', 'referencePolicy', 'fixedReferences', 'styleGroupIds', 'skillIds', 'bannerAssetId', 'reproduceFromTaskId']);
export function studioDefinitionChangedFields(input: Record<string, unknown>) {
  return Array.from(new Set(Object.keys(input).map(key => key === 'prompt' ? 'templatePrompt' : key).filter(key => definitionFields.has(key)))).sort();
}
export async function recordStudioLifecycleEvent(client: Client, params: {
  actorUserId: string; ownerUserId: string; contentId: string; contentType?: 'image_studio_preset' | 'image_studio_module';
  action: StudioLifecycleAction; requestId?: unknown; entryPoint?: unknown; before?: RevisionState; after?: RevisionState; changedFields?: string[];
}) {
  await recordContentAuditLog({ actorUserId: params.actorUserId, ownerUserId: params.ownerUserId,
    contentId: params.contentId, contentType: params.contentType ?? 'image_studio_preset', action: `studio-${params.action}`,
    detail: {
      ...(typeof params.requestId === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(params.requestId) ? { requestId: params.requestId } : {}),
      entryPoint: studioLifecycleEntryPoint(params.entryPoint), before: state(params.before), after: state(params.after),
      changedFields: (params.changedFields ?? []).filter(field => definitionFields.has(field)),
    },
  }, client);
}
export function publicStudioLifecycleDetail(value: string | null): SharedStudioLifecycleDetail {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(value || '{}'); } catch { return {}; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return { ...(typeof raw.requestId === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(raw.requestId) ? { requestId: raw.requestId } : {}),
    entryPoint: studioLifecycleEntryPoint(raw.entryPoint), before: state(raw.before as RevisionState), after: state(raw.after as RevisionState),
    changedFields: Array.isArray(raw.changedFields) ? raw.changedFields.filter((field): field is string => typeof field === 'string' && definitionFields.has(field)) : [] };
}
