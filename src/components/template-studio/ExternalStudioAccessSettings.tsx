'use client';
import { useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { readJsonResponse } from '@/lib/http/json-response';

type Grant = { presetId: string; sourceRevision: string; dependencyToken: string };
type Policy = { version: 1; revision: number; mode: 'closed' | 'pilot' | 'all-external'; userIds: string[]; templates: Grant[] };
type Template = Grant & { name: string; approved: boolean; available: boolean };
type Directory = { policy: Policy; templates: Template[]; users: Array<{ id: string; name: string; email: string }>; nextCursor: string | null; error?: string };
type Operation = { requestId: string; state: 'succeeded' | 'rejected' | 'unknown'; policy: Policy | null; error: string | null };
const endpoint = '/api/admin/image-studio/external-access';

export default function ExternalStudioAccessSettings() {
  const { user, sessionChanged } = useAppSession();
  const ownerId = user?.id;
  const allowed = user?.role === 'admin' && user.account_type === 'internal' && !sessionChanged;
  const [open, setOpen] = useState(false), [draft, setDraft] = useState<Policy | null>(null);
  const [directory, setDirectory] = useState<Directory | null>(null), [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [pending, setPending] = useState<string | null>(null);
  const epoch = useRef(0), draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => { epoch.current++; setOpen(false); setDraft(null); setDirectory(null); setPending(null); setNotice(''); }, [ownerId, sessionChanged]);
  async function load(after?: string | null) {
    if (!allowed || busy || pending) return;
    setBusy(true); setNotice(''); const token = epoch.current;
    try {
      const params = new URLSearchParams({ q: query.trim() }); if (after) params.set('after', after);
      const response = await fetch(`${endpoint}?${params}`, { cache: 'no-store', headers: { 'x-app-session-user': ownerId || '' } });
      const data = await readJsonResponse<Directory>(response);
      if (token !== epoch.current) return;
      if (!response.ok) throw new Error(data.error || '读取外部开放设置失败');
      setDirectory(current => after && current ? { ...data, templates: Array.from(new Map([...current.templates, ...data.templates].map(item => [item.presetId, item])).values()) } : data);
      if (!draftRef.current) setDraft(data.policy);
      else if (draftRef.current.revision !== data.policy.revision) {
        setDraft(current => current ? { ...current, revision: data.policy.revision } : data.policy);
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
      setDraft(data.operation.policy); setDirectory(current => current ? { ...current, policy: data.operation!.policy! } : current);
      setNotice('已保存，仅影响新的外部生成');
    } else setNotice(data.operation.error || '本次设置未生效，当前选择已保留');
  }
  async function save() {
    if (!allowed || !draft || busy || pending) return;
    const requestId = crypto.randomUUID(), token = epoch.current;
    setPending(requestId); setBusy(true); setNotice('');
    try {
      await receiveOperation(await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': ownerId || '' },
        body: JSON.stringify({ requestId, revision: draft.revision, mode: draft.mode, userIds: draft.userIds, templates: draft.templates }) }), token);
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
  const locked = busy || Boolean(pending), field = { display: 'grid', gap: 6 } as const;
  return <section style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }} aria-label="外部生图开放设置">
    <button type="button" aria-expanded={open} onClick={() => { setOpen(value => !value); if (!open && !directory) void load(); }}>
      外部生图{directory ? ` · ${directory.policy.mode === 'closed' ? '已关闭' : directory.policy.mode === 'pilot' ? '指定账号' : '全部外部账号'}` : ''}
    </button>
    {open && <div style={{ display: 'grid', gap: 12, paddingTop: 12 }}>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>按现有价格生成。仅开放所选模板的执行，源提示词和素材保留在服务器；关闭后本人历史结果仍可使用。</p>
      {draft && <>
        <label style={field}>开放范围<select value={draft.mode} disabled={locked} onChange={event => setDraft({ ...draft, mode: event.target.value as Policy['mode'] })}>
          <option value="closed">关闭新生成</option><option value="pilot">指定外部账号</option><option value="all-external">全部有效外部账号</option>
        </select></label>
        <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onSubmit={event => { event.preventDefault(); void load(); }}>
          <input type="search" aria-label="搜索模板或外部账号" placeholder="搜索模板或外部账号" value={query} maxLength={80} disabled={locked} onChange={event => setQuery(event.target.value)} style={{ flex: '1 1 180px' }} />
          <button type="submit" disabled={locked}>查找 / 更新目录</button>
        </form>
        {draft.mode === 'pilot' && <fieldset disabled={locked} style={{ margin: 0, border: '1px solid var(--border)', padding: 10 }}>
          <legend>可使用的外部账号（{draft.userIds.length}）</legend>
          <div style={{ display: 'grid', gap: 8, maxHeight: 200, overflowY: 'auto' }}>{directory?.users.map(item => <label key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'start' }}>
            <input type="checkbox" checked={draft.userIds.includes(item.id)} onChange={event => setDraft({ ...draft, userIds: event.target.checked ? [...draft.userIds, item.id] : draft.userIds.filter(id => id !== item.id) })} />
            <span>{item.name}<small style={{ display: 'block', color: 'var(--text-secondary)' }}>{item.email}</small></span>
          </label>)}{!directory?.users.length && <span>没有符合条件的外部账号</span>}</div>
        </fieldset>}
        <fieldset disabled={locked} style={{ margin: 0, border: '1px solid var(--border)', padding: 10 }}>
          <legend>可执行的模板（{draft.templates.length}）</legend>
          <div style={{ display: 'grid', gap: 8, maxHeight: 240, overflowY: 'auto' }}>{directory?.templates.map(item => {
            const selected = draft.templates.find(grant => grant.presetId === item.presetId);
            const changed = selected && (selected.sourceRevision !== item.sourceRevision || selected.dependencyToken !== item.dependencyToken);
            return <div key={item.presetId} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><label style={{ display: 'flex', gap: 8, flex: 1 }}>
              <input type="checkbox" checked={Boolean(selected)} disabled={!item.available && !selected} onChange={event => setDraft({ ...draft, templates: event.target.checked
                ? [...draft.templates, { presetId: item.presetId, sourceRevision: item.sourceRevision, dependencyToken: item.dependencyToken }]
                : draft.templates.filter(grant => grant.presetId !== item.presetId) })} />
              <span>{item.name}{!item.available ? '（已不可用）' : changed ? '（版本已变化）' : ''}</span>
            </label>{changed && item.available && <button type="button" onClick={() => setDraft({ ...draft, templates: draft.templates.map(grant => grant.presetId === item.presetId
              ? { presetId: item.presetId, sourceRevision: item.sourceRevision, dependencyToken: item.dependencyToken } : grant) })}>采用当前版本</button>}</div>;
          })}{!directory?.templates.length && <span>没有符合条件的共享模板</span>}</div>
          {directory?.nextCursor && <button type="button" disabled={locked} onClick={() => void load(directory.nextCursor)}>加载更多模板</button>}
        </fieldset>
        {draft.mode === 'all-external' && <p style={{ margin: 0, fontSize: 13 }}>保存后，所有有效外部账号都可使用所选模板。请先确认现有注册范围和运行容量。</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled={locked} onClick={() => void save()}>保存开放设置</button>
          {pending && <button type="button" disabled={busy} onClick={() => void check()}>核对原保存</button>}
        </div>
      </>}
      {!draft && <button type="button" disabled={busy} onClick={() => void load()}>重新读取</button>}
      {busy && <span role="status">正在处理</span>}{notice && <p role="status" style={{ margin: 0, fontSize: 13 }}>{notice}</p>}
    </div>}
  </section>;
}
