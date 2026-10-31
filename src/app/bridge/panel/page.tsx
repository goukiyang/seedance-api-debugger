'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * SD2 生产桥浮窗工作台（嵌在插件浮窗的 chrome-extension://…/panel/panel-host.html 里）。
 * 只通过 postMessage 与插件壳通信，协议见插件 docs/arch-remote-update-v01.md §3。
 * 本页不读 Cookie 登录：壳在握手后下发 15 分钟令牌，用 Bearer 调 /api/bridge/*。
 */
type Msg = { sd2b: 1; id?: string; re?: string; type?: string; ok?: boolean; payload?: any; data?: any; error?: string };
type LogRow = { t: number; text: string; ok: boolean };

const PAGE_VERSION = '0.1.0';
let seq = 0;
const newId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

export default function BridgePanelPage() {
  const parentOrigin = useRef<string | null>(null);
  const pending = useRef(new Map<string, (m: Msg) => void>());
  const [shell, setShell] = useState<{ shellVersion: string; capabilities: string[] } | null>(null);
  const [token, setToken] = useState<string>('');
  const [user, setUser] = useState<{ name: string } | null>(null);
  const [text, setText] = useState('');
  const [submit, setSubmit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogRow[]>([]);
  const embedded = typeof window !== 'undefined' && window.parent !== window;

  const addLog = (t: string, ok = true) => setLog((l) => [{ t: Date.now(), text: t, ok }, ...l].slice(0, 30));

  const post = useCallback((m: Msg) => {
    if (!embedded) return;
    window.parent.postMessage(m, parentOrigin.current || '*');
  }, [embedded]);

  const call = useCallback((type: string, payload?: unknown, timeoutMs = 30000) => new Promise<Msg>((resolve) => {
    if (!parentOrigin.current) return resolve({ sd2b: 1, ok: false, error: '插件未连接' });
    const id = newId();
    const timer = setTimeout(() => { pending.current.delete(id); resolve({ sd2b: 1, ok: false, error: '超时' }); }, timeoutMs);
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
    if (!token) { setUser(null); return; }
    let alive = true;
    fetch('/api/bridge/me', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setUser(d?.ok ? d.user : null); })
      .catch(() => { if (alive) setUser(null); });
    return () => { alive = false; };
  }, [token]);

  const can = (cap: string) => !!shell?.capabilities.includes(cap);

  async function sendToMj() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const r = await call('task.run', { action: 'mj.send', params: { text: t, submit } });
    setBusy(false);
    if (r.ok) { addLog(`已发送到 MJ：${t.slice(0, 40)}`); setText(''); }
    else addLog(`发送失败：${r.error || '未知原因'}`, false);
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
      <textarea style={S.input} value={text} onChange={(e) => setText(e.target.value)} placeholder="输入提示词，发送到 Midjourney" rows={5} />
      <div style={S.row}>
        <label style={S.muted}><input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} /> 直接提交</label>
        <button style={S.btn} disabled={!can('mj.send') || !text.trim() || busy} onClick={sendToMj}>
          {can('mj.send') ? (busy ? '发送中…' : '发送到 MJ') : '插件版本不支持'}
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
