const FEISHU_LOCAL_RELAY_PATH = '/__sd2-feishu-local-relay';
const RELAY_BASE_URL = 'https://sd2.youdoodesign.com';

export type FeishuLocalRelay = {
  callbackUrl: string;
  next: string;
  nonce: string;
};

export type FeishuLocalRelayResult = { code: string } | { error: string };

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return false;

  try {
    return new URL(value, RELAY_BASE_URL).origin === RELAY_BASE_URL;
  } catch {
    return false;
  }
}

function parseLoopbackCallback(value: string) {
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/__sd2-feishu-callback$/.exec(value);
  if (!match) return null;

  try {
    const callback = new URL(value);
    const port = Number(match[1]);

    if (
      port < 1024
      || port > 65535
    ) {
      return null;
    }

    return callback.toString();
  } catch {
    return null;
  }
}

export function parseFeishuLocalRelay(value: unknown): FeishuLocalRelay | null {
  if (typeof value !== 'string' || !value.startsWith(`${FEISHU_LOCAL_RELAY_PATH}?`)) return null;

  try {
    const marker = new URL(value, RELAY_BASE_URL);
    if (marker.origin !== RELAY_BASE_URL || marker.pathname !== FEISHU_LOCAL_RELAY_PATH || marker.hash) return null;
    if (
      marker.searchParams.getAll('callback').length !== 1
      || marker.searchParams.getAll('next').length !== 1
      || marker.searchParams.getAll('nonce').length !== 1
    ) {
      return null;
    }
    if (Array.from(marker.searchParams.keys()).some(
      (key) => key !== 'callback' && key !== 'next' && key !== 'nonce',
    )) return null;

    const callbackValue = marker.searchParams.get('callback');
    const next = marker.searchParams.get('next');
    const nonce = marker.searchParams.get('nonce');
    if (!callbackValue || !isSafeRelativePath(next) || !nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;

    const callbackUrl = parseLoopbackCallback(callbackValue);
    return callbackUrl ? { callbackUrl, next, nonce } : null;
  } catch {
    return null;
  }
}

export function buildFeishuLocalCallbackUrl(
  relay: FeishuLocalRelay,
  result: FeishuLocalRelayResult,
) {
  const callback = new URL(relay.callbackUrl);
  if ('code' in result) callback.searchParams.set('code', result.code);
  else callback.searchParams.set('error', result.error);
  callback.searchParams.set('next', relay.next);
  callback.searchParams.set('nonce', relay.nonce);
  return callback.toString();
}
