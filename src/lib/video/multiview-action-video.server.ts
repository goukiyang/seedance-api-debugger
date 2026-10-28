import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { parseMultiviewActionBinding } from './multiview-action-contract';
import { resolveMultiviewActionForGeneration } from './multiview-action.server';
import { assertPrivateSeedanceDestination } from '@/lib/provider/jimeng';
import { generationRequestFingerprint } from '@/lib/template-studio-video-fingerprint';
import { writePrivateFields } from '@/lib/security/private-prompt-fields.server';
import { StudioError } from '@/lib/template-studio/errors';

export const multiviewActionRequestId = (runId: string) => `multiview-action:${runId}`;
export type ResolvedMultiviewActionVideo = Awaited<ReturnType<typeof resolveMultiviewActionForGeneration>>;

/** Safe original-request lookup does not need to decrypt/rebuild rules or revalidate today's context. */
export function multiviewActionVideoFingerprint(body: Record<string, unknown>) {
  return `pricing-v2:${generationRequestFingerprint({ binding: parseMultiviewActionBinding(body.multiview_action),
    prompt: body.prompt, provider: body.provider || 'seedance', model: body.model, duration: body.duration,
    resolution: body.resolution, ratio: body.ratio, project_id: body.project_id, video_card_id: body.video_card_id || null,
    baseline_task_id: body.baseline_task_id || null,
    seed: body.seed ?? -1, generate_audio: body.generate_audio ?? true, return_last_frame: body.return_last_frame ?? false,
    watermark: body.watermark ?? false, requestId: body.idempotency_key || body.request_id,
    extraMedia: ['multiview_generation', 'multiview_settings', 'multiview_preset_version', 'canvas_references', 'canvas_video_batch',
      'first_frame_url', 'last_frame_url', 'last_frame_asset_id', 'reference_image_ids', 'referenceImageIds',
      'reference_image_urls', 'referenceImageUrls', 'reference_video_urls', 'reference_audio_urls', 'frame_image_urls',
      'reference_album_ids', 'template_id', 'agent_run_id', 'roleMediaContext', 'promptMentions', 'template_studio_assets',
      'template_studio_parameters', 'video_branch_id'].map(key => [key, body[key] ?? null]) })}`;
}
export function protectMultiviewActionVideoTask<T extends { id: string }>(data: T, action: ResolvedMultiviewActionVideo | null) {
  if (!action) return data;
  return writePrivateFields(data, 'video-task', data.id, ['prompt', 'final_prompt_snapshot', 'template_studio_snapshot_json']
    .filter(field => typeof (data as Record<string, unknown>)[field] === 'string').map(field => ({ field, origins: action.origins })));
}

/** Public input stays free of fixed rules. Only the ordinary execution boundary receives prompt. */
export async function resolveMultiviewActionVideoInput(user: SessionUser, body: Record<string, unknown>,
  db: Prisma.TransactionClient = prisma, requireRequest = false) {
  if (body.multiview_action === undefined) return null;
  const binding = parseMultiviewActionBinding(body.multiview_action);
  if (!binding) throw new AuthError('动作视频的拼图与文案绑定无效，原输入已保留', 400);
  let action: ResolvedMultiviewActionVideo;
  try { action = await resolveMultiviewActionForGeneration(user, binding, db); }
  catch (error) { if (error instanceof StudioError) throw new AuthError(error.message, error.status); throw error; }
  if (!action.origins.length) throw new AuthError('动作视频私有规则尚未准备好，原输入保留', 503);
  assertPrivateSeedanceDestination(action.parameters.model, action.origins);
  const fail = () => { throw new AuthError('拼图、动作或视频参数已变化，请重新准备本次费用；未生成', 409); };
  if (body.entry !== undefined && body.entry !== 'multiview' || body.action !== undefined && body.action !== 'generate'
    || body.count !== undefined && body.count !== 1 || body.provider !== undefined && body.provider !== 'seedance'
    || body.generation_mode !== undefined && body.generation_mode !== 'first_last_frame'
    || body.prompt !== undefined && body.prompt !== action.actionText
    || body.template_studio_run_id !== undefined && body.template_studio_run_id !== action.runId
    || body.first_frame_asset_id !== undefined && body.first_frame_asset_id !== action.assetId) fail();
  const forbidden = ['multiview_generation', 'multiview_settings', 'multiview_preset_version', 'canvas_references', 'canvas_video_batch',
    'first_frame_url', 'last_frame_url', 'last_frame_asset_id', 'template_id', 'agent_run_id', 'roleMediaContext',
    'promptMentions', 'agent_prompt_snapshot', 'final_prompt_snapshot', 'template_studio_assets', 'template_studio_parameters',
    'source_task_id', 'source_draft_task_id', 'video_branch_id', 'retry_task_id',
    'seedance_edit_reference', 'omni_reference_task_type', 'audio_prompt', 'music_prompt', 'callback_url', 'execution_expires_after'];
  if (forbidden.some(key => body[key] !== undefined && body[key] !== null && body[key] !== '')
    || ['reference_image_ids', 'referenceImageIds', 'reference_image_urls', 'referenceImageUrls', 'reference_video_urls',
      'reference_audio_urls', 'frame_image_urls', 'reference_album_ids'].some(key => body[key] !== undefined
        && (!Array.isArray(body[key]) || (body[key] as unknown[]).length > 0))) fail();
  if (body.continuation !== undefined && (!body.continuation || typeof body.continuation !== 'object'
    || (body.continuation as Record<string, unknown>).mode !== 'new')) fail();
  if (body.draft !== undefined && body.draft !== false) fail();
  const parameters = { seed: -1, generate_audio: true, return_last_frame: false, watermark: false, ...action.parameters };
  for (const [key, value] of Object.entries(parameters)) {
    if (body[key] !== undefined && body[key] !== value) fail();
  }
  if (!['16:9', '9:16', '1:1'].includes(String(action.parameters.ratio))) fail();
  if (requireRequest && (body.idempotency_key !== multiviewActionRequestId(action.runId)
    || body.creation_contract_version !== 2 || typeof body.intent_id !== 'string')) {
    throw new AuthError('请从同步动作视频确认本次费用后生成，原请求编号已保留', 409);
  }
  if (body.request_id !== undefined && body.request_id !== multiviewActionRequestId(action.runId)) fail();
  return { action, body: { ...body, ...parameters, provider: 'seedance', generation_mode: 'first_last_frame',
    prompt: action.actionText, template_studio_run_id: action.runId, first_frame_asset_id: action.assetId,
    multiview_action: binding } as Record<string, unknown> };
}
