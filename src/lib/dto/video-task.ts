import type { Prisma } from '@prisma/client';
import { isExternalUser } from '@/lib/access/external-role';
import { isPrivateMultiviewTask, projectPrivateMultiviewTask, type TaskProtectionSource } from '@/lib/video/multiview-task-privacy';
import { visibleProviderErrorMessage } from '@/lib/provider/error-message';
import { taskThumbnailProjection, type TaskThumbnailProjectionSource } from '@/lib/video/task-thumbnail-projection';
import { projectVideoTaskFields } from './video-task-fields';
import { toUserSummary, userSummarySelect, type DtoViewer, type UserSummarySource } from './user';

export const videoTaskViewSelect = {
  id: true, source_metadata_json: true, provider: true, model: true, generation_mode: true, prompt: true,
  source_type: true, source_label: true, source_request_id: true, ratio: true, duration: true, resolution: true,
  seed: true, generate_audio: true, return_last_frame: true, watermark: true, reference_image_urls: true,
  reference_video_urls: true, reference_audio_urls: true, first_frame_url: true, last_frame_url: true, frame_image_urls: true,
  reference_image_ids: true, reference_album_ids: true, execution_expires_after: true,
  local_status: true, provider_status: true, provider_task_id: true, provider_client_request_id: true, is_draft: true,
  provider_draft_task_id: true, draft_upgrade_mode: true, source_draft_task_id: true, draft_contract_version: true,
  result_video_url: true, result_last_frame_url: true, local_video_path: true, public_video_url: true,
  public_video_storage_provider: true, public_video_file_size: true, public_video_cached_at: true,
  delivery_status: true, delivery_queued_at: true, delivery_started_at: true, delivery_completed_at: true,
  delivery_attempts: true, delivery_error: true, error_message: true, error_code: true,
  user_id: true, owner_user_id: true, project_id: true, video_card_id: true, video_branch_id: true,
  creation_intent_id: true, creation_contract_version: true, derived_from_task_id: true, derivation_kind: true,
  lineage_root_task_id: true, template_id: true, agent_run_id: true, selected_agent_plan_key: true,
  template_studio_run_id: true, visibility: true, version_role: true, prompt_user_edited: true,
  retention_status: true, user_deleted_at: true, user_deleted_by: true, admin_hidden_at: true, admin_hidden_by: true,
  restored_at: true, restored_by: true, delete_reason: true, estimated_cost: true, actual_cost: true, frozen_cost: true,
  refund_amount: true, pricing_snapshot: true, pricing_rule_id: true, idempotency_key: true,
  billing_scope: true, billing_account_id: true, provider_cost_status: true, provider_cost_currency: true,
  provider_estimated_amount_minor: true, provider_rule_amount_minor: true, provider_official_amount_minor: true,
  provider_final_amount_minor: true, provider_official_amount_micros: true, provider_final_amount_micros: true,
  provider_billing_status: true, provider_billing_time: true, provider_cost_confirmed_at: true,
  provider_cost_reconciled_at: true, cost_allocation_status: true, created_at: true, updated_at: true, completed_at: true,
  project: { select: { id: true, name: true, type: true } },
  video_card: { select: { id: true, title: true, objective: true, status: true, project_id: true } },
  generation_template: { select: { id: true, name: true, template_key: true, version: true, status: true } },
  owner: { select: userSummarySelect }, user: { select: userSummarySelect },
} as const satisfies Prisma.VideoTaskSelect;
export type VideoTaskViewSource = Prisma.VideoTaskGetPayload<{ select: typeof videoTaskViewSelect }>;

export function toVideoTaskView<T extends object & TaskProtectionSource>(task: T, viewer?: DtoViewer) {
  const protectedView = isPrivateMultiviewTask(task) ? projectPrivateMultiviewTask(task)
    : projectVideoTaskFields(task, { viewer, external: isExternalUser(viewer) });
  const source = task as T & Partial<TaskThumbnailProjectionSource>;
  const preview = typeof source.id === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(source.id) && typeof source.local_status === 'string'
    ? taskThumbnailProjection(source as TaskThumbnailProjectionSource) : {};
  const relations = protectedView as { owner?: UserSummarySource | null; user?: UserSummarySource | null; error_message?: string | null; local_status?: string };
  const identities = 'owner' in relations || 'user' in relations ? {
    owner: toUserSummary(relations.owner || relations.user, viewer), submitted_user: toUserSummary(relations.user, viewer),
  } : {};
  return { ...projectVideoTaskFields(protectedView, { viewer, external: isExternalUser(viewer) }), ...preview, ...identities,
    ...(relations.local_status === 'failed' && !isPrivateMultiviewTask(task)
      ? { error_message: visibleProviderErrorMessage(relations.error_message) } : {}),
  };
}
