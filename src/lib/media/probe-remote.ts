import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { safeFetch } from '@/lib/net/safe-fetch';

const exec = promisify(execFile);
export type RemoteMediaKind = 'image' | 'video' | 'audio';
export const REMOTE_MEDIA_MAX_BYTES = { image: 20 * 1024 * 1024, video: 200 * 1024 * 1024, audio: 50 * 1024 * 1024 };
const formats = { image: 'image2,jpeg_pipe,png_pipe,webp_pipe,gif,bmp_pipe,mov', video: 'mov,matroska,webm,avi', audio: 'mov,mp3,wav,ogg,flac,aac' };
export const mediaInputFlags = (kind: RemoteMediaKind) => ['-protocol_whitelist', 'file,pipe', '-format_whitelist', formats[kind]];
type MediaOptions = { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number; frames?: boolean };
export type MediaProbe = {
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string;
    tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number }> }>;
  format?: { duration?: string; format_name?: string };
  frames?: Array<{ best_effort_timestamp_time?: string }>;
};

export async function downloadRemoteMedia(url: string, kind: RemoteMediaKind, file: string, options: MediaOptions = {}) {
  const response = await safeFetch(url, { maxBytes: Math.min(options.maxBytes || REMOTE_MEDIA_MAX_BYTES[kind], REMOTE_MEDIA_MAX_BYTES[kind]),
    timeoutMs: options.timeoutMs || 90_000, allowRedirects: true, signal: options.signal });
  if (!response.ok || !response.body) throw new Error('MEDIA_UNAVAILABLE');
  const mime = response.headers.get('content-type')?.split(';')[0].trim();
  if (mime && !mime.startsWith(`${kind}/`) && mime !== 'application/octet-stream') {
    await response.body.cancel(); throw new Error('MEDIA_TYPE_NOT_ALLOWED');
  }
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
}

export async function withRemoteMediaFile<T>(url: string, kind: RemoteMediaKind, action: (file: string) => Promise<T>, options: MediaOptions = {}): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sd2-public-media-'));
  try {
    const file = path.join(dir, 'media.bin');
    await downloadRemoteMedia(url, kind, file, options);
    return await action(file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function probeMediaFile(file: string, kind: RemoteMediaKind, options: MediaOptions = {}): Promise<MediaProbe> {
  if (!path.isAbsolute(file) || file.includes('\0')) throw new Error('INVALID_LOCAL_PATH');
  const { stdout } = await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', ...mediaInputFlags(kind), '-threads', '1',
    ...(options.frames ? ['-select_streams', 'v:0', '-show_frames'] : []), '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:stream_tags=rotate:stream_side_data=rotation:format=duration,format_name' + (options.frames ? ':frame=best_effort_timestamp_time' : ''),
    '-of', 'json', file], { timeout: options.frames ? 60_000 : 15_000, maxBuffer: options.frames ? 4 * 1024 * 1024 : 64 * 1024, signal: options.signal });
  return JSON.parse(stdout) as MediaProbe;
}

export function probeRemoteMedia(url: string, kind: RemoteMediaKind, options: MediaOptions = {}) {
  return withRemoteMediaFile(url, kind, file => probeMediaFile(file, kind, options), options);
}
