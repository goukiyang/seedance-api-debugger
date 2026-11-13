'use client';
import { useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { readJsonResponse } from '@/lib/http/json-response';

type Grant = { presetId: string; sourceRevision: string; dependencyToken: string };
type Policy = { version: 1; revision: number; mode: 'closed' | 'pilot' | 'all-external'; userIds: string[]; templates: Grant[] };
type Directory = { policy: Policy; error?: string };
type Draft = { revision: number; enabled: boolean };
const switchDraft = (policy: Policy): Draft => ({ revision: policy.revision, enabled: policy.mode !== 'closed' });
type Operation = { requestId: string; state: 'succeeded' | 'rejected' | 'unknown'; policy: Policy | null; error: string | null };
const endpoint = '/api/admin/image-studio/external-access';

export default function ExternalStudioAccessSettings() {
  const { user, sessionChanged } = useAppSession();
  const ownerId = user?.id;
  const allowed = user?.role === 'admin' && user.account_type === 'internal' && !sessionChanged;
  const [open, setOpen] = useState(false), [draft, setDraft] = useState<Draft | null>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [pending, setPending] = useState<string | null>(null);
  const epoch = useRef(0), draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => { epoch.current++; setOpen(false); setDraft(null); setDirectory(null); setPending(null); setNotice(''); }, [ownerId, sessionChanged]);
  async function load() {
    if (!allowed || busy || pending) return;
    setBusy(true); setNotice(''); const token = epoch.current;
    try {
      const response = await fetch(endpoint, { cache: 'no-store', headers: { 'x-app-session-user': ownerId || '' } });
      const data = await readJsonResponse<Directory>(response);
      if (token !== epoch.current) return;
      if (!response.ok) throw new Error(data.error || '读取外部开放设置失败');
      setDirectory(data);
      if (!draftRef.current) setDraft(switchDraft(data.policy));
      else if (draftRef.current.revision !== data.policy.revision) {
        setDraft(current => current ? { ...current, revision: data.policy.revision } : switchDraft(data.policy));
        setNotice('已读取最新设置，当前选择已保留，请核对后保存');
      }
    } catch (error) { if (token === epoch.current) setNotice(error instanceof Error ? error.message : '读取失败，当前选择已保留'); }
    finally { if (token === epoch.current) setBusy(false); }
  }
  async function receiveOperation(response: Response, token: number) {
    const data = await readJsonResponse<{ operation?: Operation; error?: string }>(response);
    if (token !== epoch.current) return;
    if (!response.ok || !data.operation) throw new Error(data.error || '保存结果尚未确认，请核对原保存');
    if (data.operation.state === 'unknown') { setNotice('保存结果尚未确认，当前选择已保留，请继续核对原保存'); return; }
    setPending(null);
    if (data.operation.state === 'succeeded' && data.operation.policy) {
      setDraft(switchDraft(data.operation.policy)); setDirectory(current => current ? { ...current, policy: data.operation!.policy! } : current);
      setNotice('已保存，仅影响新的外部生成');
    } else setNotice(data.operation.error || '本次设置未生效，当前选择已保留');
  }
  async function save() {
    if (!allowed || !draft || busy || pending) return;
    const requestId = crypto.randomUUID(), token = epoch.current;
    setPending(requestId); setBusy(true); setNotice('');
    try {
      await receiveOperation(await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': ownerId || '' },
        body: JSON.stringify({ requestId, revision: draft.revision, enabled: draft.enabled }) }), token);
    } catch (error) { if (token === epoch.current) setNotice(error instanceof Error ? error.message : '保存结果尚未确认，请核对原保存'); }
    finally { if (token === epoch.current) setBusy(false); }
  }
  async function check() {
    if (!allowed || !pending || busy) return;
    const token = epoch.current; setBusy(true);
    try { await receiveOperation(await fetch(`${endpoint}?requestId=${encodeURIComponent(pending)}`, { cache: 'no-store', headers: { 'x-app-session-user': ownerId || '' } }), token); }
    catch (error) { if (token === epoch.current) setNotice(error instanceof Error ? error.message : '暂时无法核对，请保留原编号'); }
    finally { if (token === epoch.current) setBusy(false); }
  }
  if (!allowed) return null;
  const locked = busy || Boolean(pending);
  return <section style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }} aria-label="外部生图开放设置">
    <button type="button" aria-expanded={open} onClick={() => { setOpen(value => !value); if (!open && !directory) void load(); }}>
      外部生图{directory ? ` · ${directory.policy.mode === 'closed' ? '已关闭' : directory.policy.mode === 'pilot' ? '部分开放' : '已开放'}` : ''}
    </button>
    {open && <div style={{ display: 'grid', gap: 12, paddingTop: 12 }}>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>开启后，全部有效外部账号登录即可使用当前共享的生图模板，按原价格生成。新账号和新共享模板自动适用；关闭后本人历史结果仍保留。</p>
      {draft && <>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" role="switch" checked={draft.enabled} disabled={locked} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
          向全部外部用户开放生图模板
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled={locked} onClick={() => void save()}>保存开放设置</button>
          <button type="button" disabled={locked} onClick={() => void load()}>重新读取</button>
          {pending && <button type="button" disabled={busy} onClick={() => void check()}>核对原保存</button>}
        </div>
      </>}
      {!draft && <button type="button" disabled={busy} onClick={() => void load()}>重新读取</button>}
      {busy && <span role="status">正在处理</span>}{notice && <p role="status" style={{ margin: 0, fontSize: 13 }}>{notice}</p>}
    </div>}
  </section>;
}
