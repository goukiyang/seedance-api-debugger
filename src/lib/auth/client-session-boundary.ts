'use client';

// No account identity or credentials are persisted or sent between tabs.
const key = 'sd2:session-exit';
const channelName = 'sd2-session-exit';
const localEvent = 'sd2-local-session-exit';
let blocked = false;
export type SessionBoundaryReason = 'logged_out' | 'unconfirmed';
type SessionBoundaryEvent = { eventId: string; reason: SessionBoundaryReason };
export function parseClientSessionEvent(value: unknown): SessionBoundaryEvent | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { value = { eventId: value, reason: 'logged_out' }; }
  }
  if (!value || typeof value !== 'object') return null;
  const event = value as { eventId?: unknown; reason?: unknown };
  if (typeof event.eventId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(event.eventId)
    || (event.reason !== 'logged_out' && event.reason !== 'unconfirmed')) return null;
  return { eventId: event.eventId, reason: event.reason };
}
export type LogoutOutcome = 'confirmed' | 'known_failure' | 'unknown';
export function logoutResponseOutcome(response: { ok: boolean; status: number }, body: unknown): LogoutOutcome {
  const result = body && typeof body === 'object' ? body as { ok?: unknown } : null;
  if (response.ok && result?.ok === true) return 'confirmed';
  if (!response.ok && response.status >= 400 && response.status < 500 && result?.ok === false) return 'known_failure';
  return 'unknown';
}
export function clientSessionNotice(reason: SessionBoundaryReason) {
  return reason === 'unconfirmed'
    ? { title: '登录状态待确认', message: '退出结果尚未确认，服务器可能已退出。本页输入仍保留，操作已暂停，请前往登录重新确认账号。按账号保存的草稿不会清除。' }
    : { title: '账号已退出', message: '当前账号已退出。本页输入仍保留，操作已暂停，避免提交到其它账号。按账号保存的草稿不会清除。' };
}
export function isClientSessionBlocked() { return blocked; }
export function lockClientSession(reason: SessionBoundaryReason = 'logged_out') {
  window.dispatchEvent(new CustomEvent(localEvent, { detail: { eventId: crypto.randomUUID(), reason } }));
}

export function broadcastSessionExit(reason: SessionBoundaryReason = 'logged_out') {
  const event: SessionBoundaryEvent = { eventId: crypto.randomUUID(), reason };
  try { localStorage.setItem(key, JSON.stringify(event)); } catch { /* BroadcastChannel remains available independently. */ }
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(channelName);
      channel.postMessage(event);
      channel.close();
    } catch { /* Storage delivery still works when channels are unavailable. */ }
  }
}

export function watchSessionExit(onExit: (reason: SessionBoundaryReason) => void) {
  let latest: string | null = null;
  // Existing markers establish a baseline; a fresh login must not replay them.
  try { latest = parseClientSessionEvent(localStorage.getItem(key))?.eventId || null; } catch { /* Storage is optional. */ }
  const receive = (value: unknown) => {
    const event = parseClientSessionEvent(value);
    if (!event || event.eventId === latest) return;
    latest = event.eventId;
    blocked = true;
    onExit(event.reason);
  };
  const storage = (event: StorageEvent) => {
    try { if (event.key === key && event.storageArea === localStorage) receive(event.newValue); } catch { /* Storage may be disabled after mount. */ }
  };
  const resume = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    try { receive(localStorage.getItem(key)); } catch { /* No stored event is not evidence of a changed session. */ }
  };
  let channel: BroadcastChannel | null = null;
  try { if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(channelName); } catch { /* Storage delivery is independent. */ }
  if (channel) channel.onmessage = event => receive(event.data);
  const local = (event: Event) => receive((event as CustomEvent).detail);
  window.addEventListener(localEvent, local);
  window.addEventListener('storage', storage);
  window.addEventListener('pageshow', resume);
  return () => { channel?.close(); window.removeEventListener(localEvent, local); window.removeEventListener('storage', storage); window.removeEventListener('pageshow', resume); };
}
