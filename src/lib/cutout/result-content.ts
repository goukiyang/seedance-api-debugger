import type { ContentKey } from '@/lib/content-reactions/types';
import type { CutoutJob } from './types';

export type CutoutResultSelector = 'result' | `character_${number}`;
const jobPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const selectorPattern = /^(result|character_(?:0|[1-9][0-9]{0,3}))$/;

export function parseCutoutResultKey(key: string): { jobId: string; selector: CutoutResultSelector } | null {
  const match = /^cutout_result:([a-zA-Z0-9_-]{1,128})__(result|character_(?:0|[1-9][0-9]{0,3}))$/.exec(key);
  return match ? { jobId: match[1], selector: match[2] as CutoutResultSelector } : null;
}

function resultPath(jobId: string, value?: string | null) {
  if (!jobPattern.test(jobId) || !value) return null;
  const input = value.trim();
  const match = /^\/api\/(?:cutout\/)?v1\/results\/([^/?#]+)\/([^/?#]+)$/.exec(input);
  let filename: string;
  try {
    if (match) {
      if (decodeURIComponent(match[1]) !== jobId) return null;
      filename = decodeURIComponent(match[2]);
    } else filename = input;
  } catch { return null; }
  if (!filename || filename.length > 255 || /[\/\\\u0000-\u001f\u007f?#%]/.test(filename) || filename.includes('..') || !/\.(png|jpe?g|webp|avif)$/i.test(filename)) return null;
  return `/api/cutout/v1/results/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
}

export function cutoutResultContent(job: CutoutJob, selector: CutoutResultSelector): { key: ContentKey; url: string; filename: string; title: string } | null {
  if (job.status !== 'succeeded' || !job.result || !jobPattern.test(job.job_id) || !selectorPattern.test(selector)) return null;
  const item = selector === 'result' ? null : job.kind === 'characters' ? job.result.items?.[Number(selector.slice(10))] : null;
  if (selector !== 'result' && !item) return null;
  const url = resultPath(job.job_id, item ? item.result_url || item.result_filename : job.result.result_url);
  if (!url) return null;
  const filename = decodeURIComponent(url.split('/').at(-1)!);
  return { key: `cutout_result:${job.job_id}__${selector}`, url, filename, title: item?.name || (selector === 'result' ? '抠图结果' : '角色抠图结果') };
}
