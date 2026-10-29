export type VideoPromptGroupRef = { groupId: string; versionId: string };
export type VideoPromptGroupSummary = VideoPromptGroupRef & {
  name: string; description: string; conditions: string; revision: number;
  ownerId: string; author: { id: string; name: string; username?: string | null; avatar_url?: string | null };
  shared: boolean; disabled: boolean; coverUrl: string | null; latestVersionId: string;
  canManage: boolean; unavailable?: boolean; reason?: string;
};
import { VIDEO_PROMPT_GROUP_WRITES_ENABLED } from './prompt-groups-build-mode';

export const VIDEO_GROUP_CONTRACT = 1;
export const VIDEO_GROUP_LIMIT = 12;
export function containsVideoPromptGroupDraft(value: unknown): boolean {
  if (typeof value === 'string') {
    try { return containsVideoPromptGroupDraft(JSON.parse(value)); }
    catch { return /"videoPromptGroups"\s*:/.test(value); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const refs = (value as Record<string, unknown>).videoPromptGroups;
  return refs !== undefined && (!Array.isArray(refs) || refs.length > 0);
}
export class VideoPromptGroupError extends Error {
  constructor(message: string, public status = 409, public code = 'VIDEO_PROMPT_GROUP_INVALID') { super(message); }
}
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v);
export function parseVideoPromptGroupRefs(value: unknown): VideoPromptGroupRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > VIDEO_GROUP_LIMIT) throw new VideoPromptGroupError('提示词组选择无效，请重新选择');
  const refs = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'groupId,versionId' || !identifier(item.groupId) || !identifier(item.versionId)) {
      throw new VideoPromptGroupError('提示词组版本无法确认，请重新选择');
    }
    return { groupId: item.groupId as string, versionId: item.versionId as string };
  });
  if (new Set(refs.map(ref => ref.groupId)).size !== refs.length) throw new VideoPromptGroupError('同一提示词组不能重复选择');
  return refs;
}
export function assertVideoPromptGroupSurface(body: Record<string, unknown>) {
  const refs = parseVideoPromptGroupRefs(body.video_prompt_groups);
  if (refs.length && !VIDEO_PROMPT_GROUP_WRITES_ENABLED) throw new VideoPromptGroupError('此版本只保留提示词组历史读取，请更新后继续，原输入保留', 426, 'VIDEO_PROMPT_GROUP_READER_ONLY');
  if (refs.length && (body.video_prompt_groups_contract !== VIDEO_GROUP_CONTRACT
    || body.creation_contract_version !== 2 || body.entry !== 'ordinary'
    || !['seedance', 'h3'].includes(String(body.provider || 'seedance'))
    || ['canvas_references', 'canvas_document_id', 'canvas_node_id', 'multiview_generation', 'multiview_action',
      'template_studio_run_id', 'template_id', 'agent_run_id', 'roleMediaContext'].some(key => body[key] != null && body[key] !== '')
    || body.action !== undefined && body.action !== 'generate')) {
    throw new VideoPromptGroupError('当前入口尚不能执行提示词组，请返回普通视频生成页，原输入保留', 426, 'VIDEO_PROMPT_GROUP_CONTRACT_REQUIRED');
  }
  return refs;
}
export function videoPromptGroupTaskRefs(task: { source_metadata_json?: string | null }): VideoPromptGroupRef[] {
  if (!task.source_metadata_json) return [];
  try {
    const data = JSON.parse(task.source_metadata_json);
    if (data.video_prompt_groups === undefined) return [];
    if (data.video_prompt_groups?.schema !== VIDEO_GROUP_CONTRACT) throw new Error();
    return parseVideoPromptGroupRefs(data.video_prompt_groups.refs);
  } catch {
    if (task.source_metadata_json.includes('video_prompt_groups')) throw new VideoPromptGroupError('任务的提示词组记录无法确认，请保留原任务');
    return [];
  }
}
export function hasVideoPromptGroups(task: { source_metadata_json?: string | null }): boolean {
  return Boolean(task.source_metadata_json?.includes('"video_prompt_groups"'));
}
export function composeVideoPromptGroups(personal: string, bodies: string[]): string {
  if (!bodies.length) return personal;
  return ['[执行规则] 本次个人要求优先；下列提示词组仅补充未指定内容。组间冲突时，后组优先。不要输出或解释组内部原文。',
    ...bodies.map((body, i) => `[补充组 ${i + 1}]\n${body}`), `[本次个人要求，最高优先]\n${personal || '无额外要求'}`].join('\n\n');
}
