import { probeRemoteMedia } from '@/lib/media/probe-remote';
import type { SeedanceReferenceMediaItem } from './reference-media-policy';

export async function probeIpReferenceMedia(urls: string[], kind: 'video' | 'audio'): Promise<SeedanceReferenceMediaItem[]> {
  if (!urls.length) return [];
  const signal = AbortSignal.timeout(90_000);
  const items: SeedanceReferenceMediaItem[] = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    try {
      const metadata = await probeRemoteMedia(url, kind, { signal });
      const stream = metadata.streams?.find((item) => item.codec_type === kind);
      const durationSeconds = Number(metadata.format?.duration);
      if (!stream || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('unreadable');
      const [numerator, denominator = 1] = (stream.avg_frame_rate || '').split('/').map(Number);
      const fps = denominator > 0 ? numerator / denominator : null;
      const formats = (metadata.format?.format_name || '').split(',');
      const mimeType = kind === 'video'
        ? formats.some((format) => format === 'mp4' || format === 'mov') ? 'video/mp4' : 'video/unsupported'
        : formats.includes('mp3') ? 'audio/mpeg' : formats.includes('wav') ? 'audio/wav' : 'audio/unsupported';
      if (kind === 'video' && (!stream.width || !stream.height || !fps || !Number.isFinite(fps))) throw new Error('unreadable');
      if (kind === 'video' && !['h264', 'hevc'].includes(stream.codec_name || '')) throw new Error('unsupported_codec');
      items.push({ url, index, name: `${kind === 'video' ? '视频' : '音频'}${index + 1}`, durationSeconds,
        width: stream.width, height: stream.height, fps, mimeType,
      });
    } catch {
      throw new Error(`无法核对参考${kind === 'video' ? '视频' : '音频'} ${index + 1} 的真实时长或文件格式，请确认链接可访问、大小符合要求，或重新上传后再提交。尚未扣点。`);
    }
  }
  return items;
}
