'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * SD2 生产桥浮窗工作台（嵌在插件浮窗的 chrome-extension://…/panel/panel-host.html 里）。
 * 只通过 postMessage 与插件壳通信，协议见插件 docs/arch-remote-update-v01.md §3。
 * 本页不读 Cookie 登录：壳在握手后下发 15 分钟令牌，用 Bearer 调 /api/bridge/*。
 */
type Msg = { sd2b: 1; id?: string; re?: string; type?: string; ok?: boolean; stage?: string; payload?: any; data?: any; error?: string };
type LogRow = { t: number; text: string; ok: boolean };
type PanelOperation = { id: string; text: string; submit: boolean; unknown?: boolean };

const PAGE_VERSION = '0.1.0';
const newId = () => crypto.randomUUID();

export default function BridgePanelPage() {
  const parentOrigin = useRef<string | null>(null);
  const pending = useRef(new Map<string, (m: Msg) => void>());
  const [shell, setShell] = useState<{ shellVersion: string; capabilities: string[] } | null>(null);
  const [token, setToken] = useState<string>('');
  const [user, setUser] = useState<{ name: string } | null>(null);
  const [text, setText] = useState('');
  const [submit, setSubmit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const originalSend = useRef<PanelOperation | null>(null);
  const draftOwner = useRef('');
  const draftValue = useRef({ text: '', unconfirmed: false });
  const persistDraft = useCallback(() => {
    if (!draftOwner.current) return;
    try { sessionStorage.setItem(`sd2b-panel-draft:${draftOwner.current}`, JSON.stringify({ ...draftValue.current, operation: originalSend.current })); } catch { /* Restricted iframe storage: keep the live input. */ }
  }, []);
  const [log, setLog] = useState<LogRow[]>([]);
  const embedded = typeof window !== 'undefined' && window.parent !== window;

  const addLog = (t: string, ok = true) => setLog((l) => [{ t: Date.now(), text: t, ok }, ...l].slice(0, 30));

  const post = useCallback((m: Msg) => {
    if (!embedded) return;
    window.parent.postMessage(m, parentOrigin.current || '*');
  }, [embedded]);

  const call = useCallback((type: string, payload?: unknown, timeoutMs = 30000, operationId?: string) => new Promise<Msg>((resolve) => {
    if (!parentOrigin.current) return resolve({ sd2b: 1, ok: false, error: '插件未连接' });
    const id = operationId || newId();
    const timer = setTimeout(() => { pending.current.delete(id); resolve({ sd2b: 1, ok: false, stage: 'unknown', error: '发送结果待确认，原内容已保留' }); }, timeoutMs);
    pending.current.set(id, (m) => { clearTimeout(timer); resolve(m); });
    post({ sd2b: 1, id, type, payload });
  }), [post]);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== window.parent || typeof ev.origin !== 'string' || !ev.origin.startsWith('chrome-extension://')) return;
      const m = ev.data as Msg;
      if (!m || m.sd2b !== 1) return;
      if (m.re && pending.current.has(m.re)) {
        const fn = pending.current.get(m.re)!;
        pending.current.delete(m.re);
        fn(m);
        return;
      }
      if (m.type === 'hello.ack') {
        parentOrigin.current = ev.origin;
        setShell({ shellVersion: String(m.payload?.shellVersion || ''), capabilities: Array.isArray(m.payload?.capabilities) ? m.payload.capabilities : [] });
      } else if (m.type === 'auth.token' && ev.origin === parentOrigin.current) {
        setToken(typeof m.payload?.token === 'string' ? m.payload.token : '');
      } else if (m.type === 'task.progress' && ev.origin === parentOrigin.current) {
        addLog(String(m.payload?.text || ''), m.payload?.ok !== false);
      }
    }
    window.addEventListener('message', onMessage);
    if (embedded) window.parent.postMessage({ sd2b: 1, id: newId(), type: 'hello', payload: { page: 'panel', pageVersion: PAGE_VERSION } }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [embedded]);

  useEffect(() => {
    if (!token) { persistDraft(); draftOwner.current = ''; originalSend.current = null; draftValue.current = { text: '', unconfirmed: false }; setText(''); setUnconfirmed(false); setBusy(false); setUser(null); setLog([]); return; }
    let alive = true;
    fetch('/api/bridge/me', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const owner = d?.ok && d.user?.id ? String(d.user.id) : '';
        if (owner !== draftOwner.current) {
          const freshText = !draftOwner.current ? draftValue.current.text : '';
          persistDraft(); draftOwner.current = owner;
          let saved: { text?: string; unconfirmed?: boolean; operation?: PanelOperation } = {};
          try { const value = JSON.parse(sessionStorage.getItem(`sd2b-panel-draft:${owner}`) || '{}'); saved = value && typeof value === 'object' ? value : {}; } catch { /* Keep account drafts separate even when browser storage is unavailable. */ }
          const restored = { text: freshText || (typeof saved.text === 'string' ? saved.text : ''), unconfirmed: !freshText && saved.unconfirmed === true };
          const operation = saved.operation;
          draftValue.current = restored; originalSend.current = !freshText && operation && typeof operation.id === 'string' && typeof operation.text === 'string' && typeof operation.submit === 'boolean' ? operation : null;
          if (originalSend.current) setSubmit(originalSend.current.submit);
          setText(restored.text); setUnconfirmed(restored.unconfirmed); setBusy(false); setLog([]);
        }
        setUser(d?.ok ? d.user : null);
      })
      .catch(() => { if (alive) setUser(null); });
    return () => { alive = false; };
  }, [token, persistDraft]);

  const can = (cap: string) => !!shell?.capabilities.includes(cap);

  async function sendToMj() {
    const t = text.trim();
    if (!t || busy) return;
    if (!can('task.receipts') && originalSend.current?.unknown && originalSend.current.text === t && originalSend.current.submit === submit) {
      setUnconfirmed(true); addLog('当前插件不支持按原号核对，请先更新到 0.5.0 或更新版本；未重新发送。', false); return;
    }
    const owner = draftOwner.current;
    if (!originalSend.current || originalSend.current.text !== t || originalSend.current.submit !== submit) originalSend.current = { id: newId(), text: t, submit };
    originalSend.current.unknown = true;
    draftValue.current.unconfirmed = true; persistDraft();
    setBusy(true);
    const r = await call('task.run', { action: 'mj.send', params: { text: t, submit } }, 30000, originalSend.current.id);
    if (owner !== draftOwner.current) return;
    setBusy(false);
    if (r.ok) {
      const labels: Record<string, string> = { queued: '已暂存，等待 MJ 页接收', sent: '已提交到 MJ，结果请在原站查看', filled: '已填入 MJ，尚未提交', enqueued: '已加入 MJ 队列' };
      addLog(`${labels[r.data?.stage] || '插件已接收操作'}：${t.slice(0, 40)}${r.data?.note ? ` · ${r.data.note}` : ''}`);
      setUnconfirmed(false); originalSend.current = null;
      // A late receipt must not clear a newer draft typed while this request was running.
      setText(current => { const next = current.trim() === t ? '' : current; draftValue.current = { text: next, unconfirmed: false }; persistDraft(); return next; });
    } else {
      const unknown = r.stage === 'unknown' || /待确认|超时|中断/.test(r.error || '');
      if (originalSend.current) originalSend.current.unknown = unknown;
      setUnconfirmed(unknown); draftValue.current.unconfirmed = unknown; persistDraft();
      addLog(r.error || '操作未完成，原内容已保留', false);
    }
  }

  if (!embedded) {
    return <main style={S.wrap}><p style={S.muted}>这个页面只在「SD2 生产桥」插件的浮窗里使用。</p></main>;
  }

  return (
    <main style={S.wrap}>
      <header style={S.head}>
        <strong>SD2 工作台</strong>
        <span style={S.muted}>{user ? user.name : shell ? '登录中…' : '连接插件中…'}{shell ? ` · 插件 ${shell.shellVersion}` : ''}</span>
      </header>
      {shell && !token && <p style={S.warn}>未拿到登录令牌：请先在 sd2.youdooart.com 登录，然后重新打开浮窗。</p>}
      <textarea style={S.input} value={text} onChange={(e) => { const value = e.target.value; setText(value); setUnconfirmed(false); draftValue.current = { text: value, unconfirmed: false }; persistDraft(); }} placeholder="输入提示词，发送到 Midjourney" rows={5} />
      <div style={S.row}>
        <label style={S.muted}><input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} /> 直接提交</label>
        <button style={S.btn} disabled={!user || !can('mj.send') || !text.trim() || busy || (unconfirmed && !can('task.receipts'))} onClick={sendToMj}>
          {can('mj.send') ? (busy ? '处理中…' : unconfirmed ? (can('task.receipts') ? '核对原发送' : '请更新插件后核对') : submit ? '提交到 MJ' : '仅填入 MJ') : '插件版本不支持'}
        </button>
      </div>
      <ul style={S.log}>
        {log.map((r) => <li key={r.t + r.text} style={{ color: r.ok ? '#374151' : '#b91c1c' }}>{new Date(r.t).toLocaleTimeString()} {r.text}</li>)}
      </ul>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { font: '14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif', padding: 12, color: '#111827', background: '#fff', minHeight: '100vh', boxSizing: 'border-box' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
  muted: { color: '#6b7280', fontSize: 12 },
  warn: { color: '#b45309', fontSize: 12, margin: '4px 0 8px' },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 8, padding: 8, resize: 'vertical', font: 'inherit' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0' },
  btn: { background: '#2563eb', color: '#fff', border: 0, borderRadius: 8, padding: '6px 14px', cursor: 'pointer' },
  log: { listStyle: 'none', padding: 0, margin: 0, fontSize: 12, maxHeight: 240, overflow: 'auto' },
};
