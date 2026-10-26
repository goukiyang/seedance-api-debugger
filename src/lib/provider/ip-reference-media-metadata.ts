import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fetchPublicMedia } from '@/lib/media/preview-response';
import type { SeedanceReferenceMediaItem } from './reference-media-policy';

const execFileAsync = promisify(execFile);

export async function probeIpReferenceMedia(urls: string[], kind: 'video' | 'audio'): Promise<SeedanceReferenceMediaItem[]> {
  if (!urls.length) return [];
  const signal = AbortSignal.timeout(90_000);
  const items: SeedanceReferenceMediaItem[] = [];
  const maxBytes = (kind === 'video' ? 200 : 15) * 1024 * 1024;
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sd2-ip-reference-'));
    const file = path.join(directory, 'media.bin');
    try {
      signal.throwIfAborted();
      const response = await fetchPublicMedia(new Request('https://sd2.invalid/reference', { signal }), url, `${kind}/octet-stream`);
      if (!response.ok || !response.body) throw new Error('unavailable');
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body.cancel();
        throw new Error('too_large');
      }
      let size = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(size > maxBytes ? new Error('too_large') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), limit, createWriteStream(file), { signal });
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mp3,wav',
        '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration,format_name',
        '-of', 'json', file,
      ], { timeout: 15_000, maxBuffer: 64 * 1024, signal });
      const metadata = JSON.parse(stdout) as {
        streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }>;
        format?: { duration?: string; format_name?: string };
      };
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
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return items;
}
