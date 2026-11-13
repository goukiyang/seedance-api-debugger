import type { MultiviewInfo } from './multiview-contract';
import type { MultiviewReferenceRecipe } from './multiview-work-contract';
import type { MultiviewActionParameters } from './multiview-action-contract';
import type { MultiviewReusePatch } from './multiview-reuse-handoff.client';

export type MultiviewActionRestore = {
  kind: 'action'; taskId: string; runId: string; workId: string; text: string;
  parameters: MultiviewActionParameters; recipe: MultiviewReferenceRecipe | null;
  info: MultiviewInfo; referenceImageUrl: string | null; warnings: string[];
};
export type MultiviewVideoRestore = MultiviewActionRestore | {
  kind: 'rotation'; taskId: string; patch: MultiviewReusePatch; warnings: string[];
};

/** Historical choices stay visible even when today's catalog no longer offers them. */
export function parseMultiviewActionInput(value: unknown): {text:string;parameters:MultiviewActionParameters}|null {
  if(!value||typeof value!=='object')return null;
  const input=value as {text?:unknown;parameters?:unknown};
  if(typeof input.text!=='string'||input.text.length>12000||!input.parameters||typeof input.parameters!=='object')return null;
  const p=input.parameters as MultiviewActionParameters;
  if(p.provider!=='seedance'||typeof p.model!=='string'||p.model.length>160||!Number.isFinite(p.duration)||p.duration<=0||p.duration>1000000
    ||!['480p','720p','1080p'].includes(p.resolution)||!['16:9','9:16','1:1'].includes(p.ratio)
    ||typeof p.project_id!=='string'||p.project_id.length>160||p.video_card_id!==null&&(typeof p.video_card_id!=='string'||p.video_card_id.length>160)
    ||p.seed!==undefined&&(!Number.isSafeInteger(p.seed)||p.seed< -1||p.seed>2147483647)
    ||['generate_audio','return_last_frame','watermark'].some(key=>p[key as keyof MultiviewActionParameters]!==undefined&&typeof p[key as keyof MultiviewActionParameters]!=='boolean'))return null;
  return {text:input.text,parameters:{provider:'seedance',model:p.model,duration:p.duration,resolution:p.resolution,ratio:p.ratio,project_id:p.project_id,video_card_id:p.video_card_id,
    ...(p.seed===undefined?{}:{seed:p.seed}),...(p.generate_audio===undefined?{}:{generate_audio:p.generate_audio}),
    ...(p.return_last_frame===undefined?{}:{return_last_frame:p.return_last_frame}),...(p.watermark===undefined?{}:{watermark:p.watermark})}};
}
