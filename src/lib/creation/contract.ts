import { PublicApiError } from '@/lib/http/public-error';

export const VIDEO_CREATION_CAPABILITY = 'video_creation_flow_v2' as const;
export const VIDEO_CREATION_CONTRACT_VERSION = 2 as const;
export type CreationAction = 'generate' | 'enhance' | 'draft_upgrade';
export type CreationEntry = 'ordinary' | 'ip' | 'template' | 'canvas' | 'multiview' | 'enhance' | 'draft_upgrade';
export type IntentState = 'prepared' | 'awaiting_approval' | 'ready' | 'accepted' | 'rejected' | 'closed' | 'batch_active' | 'batch_settled';
export type CreationPayer = { kind: 'user' | 'project'; id: string; label: string };
export type AvailabilityReason = { code: string; message: string; field: string; action: 'select_project' | 'fix_input' | 'request_approval' | 'reopen' | 'requote' | 'query_original' | 'retry_read' };
export type CreationAvailability = { canSubmit: boolean; reasons: AvailabilityReason[]; contextRevision: string;
  quoteState: 'ready' | 'required' | 'changed' | 'unknown'; payer: CreationPayer | null };
export type CreationContinuation = { mode: 'new' | 'continue'; parent_task_id?: string };
export type VideoCreationSpec = {
  version: 2; action: CreationAction; entry: CreationEntry; project_id: string;
  video_card_id: string | null; video_branch_id: string | null; continuation: CreationContinuation;
  baseline_task_id: string | null; input_source_task_ids: string[]; count: number;
  input: Record<string, unknown>;
};
export type VideoCreationIntentDTO = {
  id: string; request_id: string; contract_version: 2; revision: number; state: IntentState;
  project_id?: string; spec?: VideoCreationSpec; payer?: CreationPayer; availability?: CreationAvailability;
  accepted_task_id: string | null; batch_id: string | null; pricing_revision?: string | null;
  quote_business_hash?: string; approval_id?: string | null;
  approval?: { id: string; status: string; reason: string | null; expires_at: string | null; remaining_count: number; authorization_round?: number; batch_revision?: number | null };
  quote?: { estimated_cost: number; pricing_revision: string; pricing_quote_token?: string }; created_at: string; updated_at: string;
};
export class CreationError extends PublicApiError {
  constructor(message: string, public readonly status = 409, public readonly code = 'creation_conflict',
    public readonly field = 'creation', public readonly action: AvailabilityReason['action'] = 'fix_input') { super(message, status, code); }
}
export function creationIdentity(value: unknown, label: string, optional = false): string | null {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new CreationError(`${label}无效`, 400, 'creation_input_invalid', label);
  return value;
}
export function isCreationV2(body: Record<string, unknown>) {
  if (body.creation_contract_version === undefined || body.creation_contract_version === 1) return false;
  if (body.creation_contract_version !== 2) throw new CreationError('请更新页面后继续，原输入已保留', 426, 'creation_contract_unsupported');
  return true;
}
