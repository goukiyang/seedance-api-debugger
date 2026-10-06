export type TimingMetric = 'completion' | 'ready' | 'delivery';
export type TimingKind = 'video' | 'enhance' | 'image';
export type TimingSummary = {
  sample_count: number; missing_count: number; average_seconds: number | null;
  median_seconds: number | null; p90_seconds: number | null; longest_seconds: number | null;
};
export type TimingRow = {
  key: string; kind: TimingKind; provider: string | null; model: string | null;
  succeeded_count: number; failed_count: number; unfinished_count: number;
  metrics: Record<TimingMetric, TimingSummary>;
};
export type GenerationTimingData = { summary: TimingRow[]; models: TimingRow[]; images_included: boolean };
type VideoTimingTask = {
  provider: string; model: string; generation_mode: string; local_status: string;
  created_at: Date; completed_at: Date | null; public_video_url: string | null;
  public_video_cached_at: Date | null; delivery_status: string | null; delivery_completed_at: Date | null;
};
type ImageTimingTask = { model: string; status: string; created_at: Date; finished_at: Date | null; usage_json: string | null };

export function elapsedSeconds(start: Date | null, end: Date | null) {
  if (!start || !end) return null;
  const seconds = (end.getTime() - start.getTime()) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// Match the existing video-delivery metrics' nearest-rank percentile convention.
export function summarizeTimings(values: Array<number | null>): TimingSummary {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (ratio: number) => valid.length ? valid[Math.ceil(valid.length * ratio) - 1] : null;
  return {
    sample_count: valid.length, missing_count: values.length - valid.length,
    average_seconds: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null,
    median_seconds: percentile(0.5), p90_seconds: percentile(0.9), longest_seconds: valid.length ? valid[valid.length - 1] : null,
  };
}

export function videoTimings(task: VideoTimingTask): Record<TimingMetric, number | null> {
  if (task.local_status !== 'succeeded') return { completion: null, ready: null, delivery: null };
  const savedAt = task.public_video_url
    ? task.public_video_cached_at || (task.delivery_status === 'succeeded' ? task.delivery_completed_at : null) : null;
  return {
    completion: elapsedSeconds(task.created_at, task.completed_at),
    ready: elapsedSeconds(task.created_at, savedAt), delivery: elapsedSeconds(task.completed_at, savedAt),
  };
}

function imageTimings(task: ImageTimingTask): Record<TimingMetric, number | null> {
  let returnedAt: Date | null = null;
  try {
    const value = JSON.parse(task.usage_json || '{}')?.studioDelivery?.returnedAt;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) returnedAt = new Date(value);
  } catch {}
  const total = elapsedSeconds(task.created_at, task.finished_at);
  const validReturn = returnedAt && elapsedSeconds(task.created_at, returnedAt) !== null;
  return { completion: total, ready: total, delivery: validReturn ? elapsedSeconds(returnedAt, task.finished_at) : null };
}

type Accumulator = Omit<TimingRow, 'metrics'> & { values: Record<TimingMetric, Array<number | null>> };
export function buildGenerationTimings(videos: VideoTimingTask[], images: ImageTimingTask[], imagesIncluded: boolean): GenerationTimingData {
  const summary = new Map<TimingKind, Accumulator>();
  const models = new Map<string, Accumulator>();
  const create = (key: string, kind: TimingKind, provider: string | null, model: string | null): Accumulator => ({
    key, kind, provider, model, succeeded_count: 0, failed_count: 0, unfinished_count: 0,
    values: { completion: [], ready: [], delivery: [] },
  });
  for (const kind of ['video', 'enhance', ...(imagesIncluded ? ['image'] : [])] as TimingKind[]) summary.set(kind, create(kind, kind, null, null));
  const add = (kind: TimingKind, provider: string | null, model: string, status: string, values: Record<TimingMetric, number | null>) => {
    const key = JSON.stringify([kind, provider, model]);
    if (!models.has(key)) models.set(key, create(key, kind, provider, model));
    for (const row of [summary.get(kind)!, models.get(key)!]) {
      if (status === 'succeeded') {
        row.succeeded_count++;
        for (const metric of ['completion', 'ready', 'delivery'] as TimingMetric[]) row.values[metric].push(values[metric]);
      } else if (['failed', 'cancelled'].includes(status)) row.failed_count++;
      else row.unfinished_count++;
    }
  };
  videos.forEach(task => add(task.generation_mode === 'enhance_video' || task.provider === 'volcengine_mediakit' ? 'enhance' : 'video',
    task.provider, task.model, task.local_status, videoTimings(task)));
  if (imagesIncluded) images.forEach(task => add('image', null, task.model, task.status, imageTimings(task)));
  const finish = ({ values, ...row }: Accumulator): TimingRow => ({ ...row, metrics: {
    completion: summarizeTimings(values.completion), ready: summarizeTimings(values.ready), delivery: summarizeTimings(values.delivery),
  } });
  return { summary: Array.from(summary.values(), finish),
    models: Array.from(models.values(), finish).sort((a, b) => b.succeeded_count - a.succeeded_count || a.key.localeCompare(b.key)), images_included: imagesIncluded };
}
