import { timingSafeEqual } from 'node:crypto';
import { signPurpose, verifyPurpose } from '../security/signatures';

function payload(taskId: string) {
  if (!taskId || taskId.length > 200 || taskId.trim() !== taskId) throw new Error('Invalid callback task ID');
  return `video-callback.v2\0${taskId}`;
}

export function createVideoCallbackToken(taskId: string) {
  return signPurpose('videoCallback', payload(taskId));
}

export function redactVideoCallbackEcho(text: string, callbackUrl?: string | null) {
  if (!callbackUrl) return text;
  let url: URL;
  try { url = new URL(callbackUrl); } catch { return text; }
  if (url.pathname !== '/api/provider/seedance/callback') return text;
  const token = url.searchParams.get('token');
  if (!token) return text;
  return [callbackUrl, encodeURIComponent(callbackUrl), token, encodeURIComponent(token)]
    .reduce((value, credential) => value.split(credential).join('[internal-callback]'), text);
}

export function verifyVideoCallbackToken(input: {
  taskId: string; token: string | null; createdAt?: Date; now?: number;
}): boolean {
  if (!input.token || input.token.length > 1024) return false;
  if (input.token.startsWith('v2:')) return verifyPurpose('videoCallback', payload(input.taskId), input.token);
  const start = Date.parse(process.env.VIDEO_CALLBACK_LEGACY_STARTED_AT || '');
  const now = input.now ?? Date.now();
  // No inferred rollout time. Old bearer credentials are never valid for new tasks.
  if (!Number.isFinite(start) || now < start || now >= start + 48 * 3600000
    || !input.createdAt || !Number.isFinite(input.createdAt.getTime()) || input.createdAt.getTime() >= start) return false;
  const legacy = (process.env.VIDEO_DELIVERY_CALLBACK_SECRET || process.env.SEEDANCE_CALLBACK_SECRET || '').trim();
  if (!legacy) return false;
  const provided = Buffer.from(input.token), expected = Buffer.from(legacy);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
