'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { RelativeTime } from '@/components/RelativeTime';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { BRIDGE_TOOLS, BRIDGE_TOOL_LABELS, type BridgeBinding, type BridgeBindingOwner, type BridgeTool, type ListedBridgeBinding } from '@/lib/bridge/device-binding-types';
import styles from './devices.module.css';

type Props = { viewerId: string; initialBindings: ListedBridgeBinding[]; owners: BridgeBindingOwner[] };
type Draft = { original: ListedBridgeBinding; machineName: string; profileName: string; shared: boolean; disabled: boolean;
  disabledReason: string; ownerUserId: string; archived: boolean; accept: Record<BridgeTool, boolean>; dailyCap: string };
const LOGIN_LABEL = { ok: '已登录', none: '未登录', unknown: '未检测', blocked: '需要处理' };
const ONLINE_MS = 10 * 60 * 1000;

function makeDraft(binding: ListedBridgeBinding): Draft {
  return { original: binding, machineName: binding.machineName, profileName: binding.profileName,
    shared: binding.shared, disabled: binding.disabled, disabledReason: binding.disabledReason, ownerUserId: binding.owner.id,
    archived: binding.archived, accept: Object.fromEntries(BRIDGE_TOOLS.map(t => [t, binding.tools[t].accept])) as Draft['accept'],
    dailyCap: binding.tools.midjourney.dailyCap === undefined ? '' : String(binding.tools.midjourney.dailyCap) };
}

function OwnerSelect({ owners, value, onChange, label, allowAll = false }: {
  owners: BridgeBindingOwner[]; value: string; onChange: (value: string) => void; label: string; allowAll?: boolean;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  useDialogDismiss({ open, dialogRef: popup, branchRefs: [trigger], modal: false, onDismiss: () => setOpen(false) });
  const current = owners.find(owner => owner.id === value);
  function choose(id: string) { onChange(id); setOpen(false); setQuery(''); }
  return <div className={styles.ownerSelect}>
    <button type="button" ref={trigger} className={styles.ownerTrigger} aria-label={label} aria-haspopup="dialog"
      aria-expanded={open} onClick={() => setOpen(!open)}>
      {current ? <UserIdentityBadge user={current} size="sm" /> : <span>{allowAll ? '全部归属人' : '选择归属人'}</span>}
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div ref={popup} className={styles.ownerPopup} role="dialog" aria-label={label}>
      <input className="input" aria-label="搜索归属人" placeholder="搜索姓名" value={query} onChange={event => setQuery(event.target.value)} autoFocus />
      <div className={styles.ownerOptions}>
        {allowAll && <button type="button" onClick={() => choose('')}>全部归属人</button>}
        {owners.filter(owner => owner.name.toLowerCase().includes(query.trim().toLowerCase())).map(owner => <button type="button"
          key={owner.id} aria-pressed={value === owner.id} onClick={() => choose(owner.id)}><UserIdentityBadge user={owner} size="sm" /></button>)}
        {!owners.some(owner => owner.name.toLowerCase().includes(query.trim().toLowerCase())) && <p className={styles.muted}>没有匹配的成员</p>}
      </div>
    </div>}
  </div>;
}

function ToolStatus({ binding, tool }: { binding: BridgeBinding; tool: BridgeTool }) {
  const state = binding.tools[tool];
  return <div className={styles.toolState}>
    <span className={styles.login}><i className={styles.dot} data-login={state.login} aria-hidden="true" />{LOGIN_LABEL[state.login]}</span>
    <span className={styles.account}>{state.account || '账号未识别'}</span>
    {!state.accept && <span className={styles.muted}>未开启接单</span>}
  </div>;
}

export default function AdminBridgeDevicesClient({ viewerId, initialBindings, owners }: Props) {
  const { user, hasLoadedUser } = useAppSession();
  const sessionChanged = hasLoadedUser && (user?.id !== viewerId || user.role !== 'admin');
  const [bindings, setBindings] = useState(initialBindings);
  const [ownerId, setOwnerId] = useState(''), [tool, setTool] = useState(''), [online, setOnline] = useState(''), [version, setVersion] = useState('');
  const [view, setView] = useState<'device' | 'account'>('device');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [refreshing, setRefreshing] = useState(false), [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null), [saving, setSaving] = useState(false), [saveError, setSaveError] = useState('');
  const drafts = useRef(new Map<string, Draft>());
  const request = useRef<AbortController | null>(null), saveLock = useRef(false);
  const drawer = useRef<HTMLElement>(null), backdrop = useRef<HTMLDivElement>(null);
  const currentOwnerOptions = useMemo(() => {
    const all = new Map(owners.map(owner => [owner.id, owner]));
    bindings.forEach(binding => all.set(binding.owner.id, binding.owner));
    return Array.from(all.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }, [owners, bindings]);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch('/api/bridge/devices/bindings?scope=all' + (includeArchived ? '&includeArchived=1' : ''), {
        cache: 'no-store', signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '读取设备失败');
      setBindings(data.bindings);
      setNow(Date.now());
      setMessage('');
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '读取设备失败，可重新刷新');
    } finally {
      if (!controller.signal.aborted) setRefreshing(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    if (sessionChanged) { request.current?.abort(); drafts.current.clear(); setSelected(null); setDraft(null); return; }
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 60_000);
    const onFocus = () => { if (!saveLock.current) void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); request.current?.abort(); };
  }, [refresh, sessionChanged]);

  function closeEditor() {
    if (saveLock.current) return;
    if (draft && selected) drafts.current.set(selected, draft);
    setSelected(null); setDraft(null); setSaveError('');
  }
  useDialogDismiss({ open: Boolean(selected), dialogRef: drawer, dismissSurfaceRef: backdrop, onDismiss: closeEditor });
  useEffect(() => {
    if (!selected) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [selected]);

  const versions = useMemo(() => Array.from(new Set(bindings.map(b => b.extVersion).filter(Boolean))).sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true })), [bindings]);
  const latest = versions[0] || '';
  const filtered = bindings.filter(binding => (!ownerId || binding.owner.id === ownerId)
    && (!tool || binding.tools[tool as BridgeTool].accountKey || binding.tools[tool as BridgeTool].accept || binding.tools[tool as BridgeTool].login === 'ok' || binding.tools[tool as BridgeTool].login === 'blocked')
    && (!online || (now - binding.lastSeenAt < ONLINE_MS ? 'online' : 'offline') === online)
    && (!version || (version === 'behind' ? Boolean(binding.extVersion && binding.extVersion.localeCompare(latest, undefined, { numeric: true }) < 0) : binding.extVersion === version))
    && (includeArchived || !binding.archived));
  const accounts = new Map<string, { tool: BridgeTool; account: string; bindings: ListedBridgeBinding[] }>();
  for (const binding of filtered) for (const entry of BRIDGE_TOOLS) {
    const state = binding.tools[entry];
    if ((tool && tool !== entry) || !state.accountKey) continue;
    const key = entry + ':' + state.accountKey;
    const group = accounts.get(key) || { tool: entry, account: state.account || '账号未识别', bindings: [] };
    group.bindings.push(binding); accounts.set(key, group);
  }

  function edit(binding: ListedBridgeBinding) {
    if (saveLock.current) return;
    setDraft(drafts.current.get(binding.deviceId) || makeDraft(binding)); setSelected(binding.deviceId); setSaveError('');
  }
  function change<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(current => current ? { ...current, [key]: value } : current); }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !selected || saveLock.current || sessionChanged) return;
    const body: Record<string, unknown> = {};
    const original = draft.original;
    for (const key of ['machineName', 'profileName', 'shared', 'disabled', 'disabledReason', 'archived'] as const) {
      if (draft[key] !== original[key]) body[key] = draft[key];
    }
    if (draft.ownerUserId !== original.owner.id) body.ownerUserId = draft.ownerUserId;
    const tools: Partial<Record<BridgeTool, { accept?: boolean; dailyCap?: number }>> = {};
    for (const entry of BRIDGE_TOOLS) if (draft.accept[entry] !== original.tools[entry].accept) tools[entry] = { accept: draft.accept[entry] };
    if (draft.dailyCap !== (original.tools.midjourney.dailyCap === undefined ? '' : String(original.tools.midjourney.dailyCap))) {
      const cap = Number(draft.dailyCap);
      if (!draft.dailyCap.trim() || !Number.isInteger(cap) || cap < 0 || cap > 500) { setSaveError('MJ 每日上限请填写0–500的整数'); return; }
      tools.midjourney = { ...tools.midjourney, dailyCap: cap };
    }
    if (Object.keys(tools).length) body.tools = tools;
    if (!Object.keys(body).length) { drafts.current.delete(selected); setSelected(null); setDraft(null); return; }
    saveLock.current = true; setSaving(true); setSaveError('');
    try {
      const response = await fetch('/api/bridge/devices/bindings/' + encodeURIComponent(selected), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) { setSaveError(data.error || '保存失败，修改内容已保留'); return; }
      request.current?.abort();
      const owner = currentOwnerOptions.find(item => item.id === draft.ownerUserId) || original.owner;
      setBindings(current => current.map(item => item.deviceId === selected ? { ...data.binding, owner,
        online: Date.now() - data.binding.lastSeenAt < ONLINE_MS } : item));
      drafts.current.delete(selected); setSelected(null); setDraft(null); setMessage('已保存');
      void refresh();
    } catch { setSaveError('保存结果未确认。请关闭后刷新核对；修改内容会保留在本页。'); }
    finally { saveLock.current = false; setSaving(false); }
  }

  if (sessionChanged) return <p className={styles.surface}>账号已变化，请刷新页面后继续。</p>;
  return <div className={styles.surface}>
    <PageBanner title="设备绑定管理" actions={<button className="btn btn-secondary" type="button" disabled={refreshing} onClick={() => void refresh()}>
      <RefreshCw size={15} aria-hidden="true" />{refreshing ? '刷新中…' : '刷新'}</button>} />
    <div className={styles.toolbar}>
      <div className={styles.views} aria-label="查看方式">
        <button type="button" aria-pressed={view === 'device'} onClick={() => setView('device')}>按接单点</button>
        <button type="button" aria-pressed={view === 'account'} onClick={() => setView('account')}>按账号</button>
      </div>
      <OwnerSelect owners={currentOwnerOptions} value={ownerId} onChange={setOwnerId} label="筛选归属人" allowAll />
      <select className="input" aria-label="筛选工具" value={tool} onChange={event => setTool(event.target.value)}>
        <option value="">全部工具</option>{BRIDGE_TOOLS.map(entry => <option key={entry} value={entry}>{BRIDGE_TOOL_LABELS[entry]}</option>)}
      </select>
      <select className="input" aria-label="筛选在线状态" value={online} onChange={event => setOnline(event.target.value)}>
        <option value="">全部在线状态</option><option value="online">在线</option><option value="offline">离线</option>
      </select>
      <select className="input" aria-label="筛选插件版本" value={version} onChange={event => setVersion(event.target.value)}>
        <option value="">全部版本</option><option value="behind">早于已上报最新版</option>{versions.map(entry => <option key={entry} value={entry}>{entry}</option>)}
      </select>
      <label className={styles.check}><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />含归档</label>
    </div>
    <div className={styles.resultLine}><span>{filtered.length} 个接单点</span><span role="status">{message}</span></div>
    {view === 'device' ? <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr><th>归属人</th><th>机器 / Chrome 资料</th>{BRIDGE_TOOLS.map(entry => <th key={entry}>{BRIDGE_TOOL_LABELS[entry]}</th>)}
          <th>在线 / 最后在线</th><th>插件版本</th><th>共享 / 停用</th><th><span className={styles.srOnly}>操作</span></th></tr></thead>
        <tbody>{filtered.map(binding => <tr key={binding.deviceId}>
          <td><UserIdentityBadge user={binding.owner} size="sm" /></td>
          <td><strong>{binding.machineName || '未命名机器'}</strong><span className={styles.secondary}>{binding.profileName || '未命名资料'}</span>
            {binding.archived && <span className={styles.muted}>已归档</span>}</td>
          {BRIDGE_TOOLS.map(entry => <td key={entry}><ToolStatus binding={binding} tool={entry} /></td>)}
          <td><span className={styles.login}><i className={styles.dot} data-login={now - binding.lastSeenAt < ONLINE_MS ? 'ok' : 'unknown'} aria-hidden="true" />
            {now - binding.lastSeenAt < ONLINE_MS ? '在线' : '离线'}</span>
            <span className={styles.secondary}>{binding.lastSeenAt ? <RelativeTime value={new Date(binding.lastSeenAt).toISOString()} /> : '尚无心跳'}</span></td>
          <td>{binding.extVersion || '未知'}</td>
          <td><span>{binding.shared ? '已共享' : '本人使用'}</span>{binding.disabled && <span className={styles.stopped} title={binding.disabledReason || undefined}>已停用</span>}</td>
          <td><button type="button" className="btn btn-secondary btn-sm" onClick={() => edit(binding)}>编辑</button></td>
        </tr>)}</tbody>
      </table>
      {!filtered.length && <p className={styles.empty}>{bindings.length ? '没有符合筛选条件的设备。' : '暂无设备绑定。在插件设置页「本机绑定」中重新检测并同步后，设备会出现在这里。'}</p>}
    </div> : <div>
      {!accounts.size && <p className={styles.empty}>当前筛选下没有已识别的工具账号。</p>}
      {Array.from(accounts, ([key, group]) => <section className={styles.accountGroup} key={key}>
        <h2>{BRIDGE_TOOL_LABELS[group.tool]} <span>{group.account}</span> <small>{group.bindings.length} 个接单点</small></h2>
        {group.bindings.map(binding => <div className={styles.accountRow} key={binding.deviceId}>
          <UserIdentityBadge user={binding.owner} size="sm" />
          <span>{binding.machineName || '未命名机器'}<span className={styles.secondary}>{binding.profileName}</span></span>
          <ToolStatus binding={binding} tool={group.tool} />
          <span className={styles.muted}>{now - binding.lastSeenAt < ONLINE_MS ? '在线' : '离线'}{binding.disabled ? ' · 已停用' : ''}{binding.archived ? ' · 已归档' : ''}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => edit(binding)}>编辑</button>
        </div>)}
      </section>)}
    </div>}
    {selected && draft && <div ref={backdrop} className={styles.backdrop}>
      <aside ref={drawer} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="binding-editor-title" tabIndex={-1}>
        <form onSubmit={save}>
          <header className={styles.drawerHeader}><h2 id="binding-editor-title">编辑接单点</h2>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭编辑" disabled={saving} onClick={closeEditor}><X size={20} /></button></header>
          <div className={styles.fields}>
            <label>归属人<OwnerSelect owners={currentOwnerOptions} value={draft.ownerUserId} onChange={value => change('ownerUserId', value)} label="修改归属人" /></label>
            <div className={styles.pair}>
              <label>机器名<input className="input" value={draft.machineName} maxLength={40} onChange={event => change('machineName', event.target.value)} /></label>
              <label>Chrome 资料名<input className="input" value={draft.profileName} maxLength={40} onChange={event => change('profileName', event.target.value)} /></label>
            </div>
            <fieldset className={styles.toolFields}><legend>允许接单</legend>
              {BRIDGE_TOOLS.map(entry => <label key={entry} className={styles.check}><input type="checkbox" checked={draft.accept[entry]}
                onChange={event => change('accept', { ...draft.accept, [entry]: event.target.checked })} />{BRIDGE_TOOL_LABELS[entry]}</label>)}
              <label className={styles.cap}>MJ 每日上限<input className="input" type="number" min={0} max={500} step={1} placeholder="未设置"
                value={draft.dailyCap} onChange={event => change('dailyCap', event.target.value)} /></label>
            </fieldset>
            <label className={styles.check}><input type="checkbox" checked={draft.shared} onChange={event => change('shared', event.target.checked)} />共享给同事使用</label>
            <label className={styles.check}><input type="checkbox" checked={draft.disabled} onChange={event => change('disabled', event.target.checked)} />停用接单</label>
            {(draft.disabled || draft.disabledReason) && <label>停用原因<textarea className="input" rows={2} maxLength={200} value={draft.disabledReason}
              onChange={event => change('disabledReason', event.target.value)} /></label>}
            <label className={styles.check}><input type="checkbox" checked={draft.archived} onChange={event => change('archived', event.target.checked)} />归档此接单点</label>
            {draft.ownerUserId !== draft.original.owner.id && <p className={styles.note}>更改归属后，原账号的插件不能继续上报这台设备。</p>}
            <details className={styles.details}><summary>设备信息</summary>
              <dl><dt>设备ID</dt><dd>{draft.original.deviceId}</dd><dt>系统 / 插件</dt><dd>{draft.original.platform || '未知'} / {draft.original.extVersion || '未知'}</dd>
                <dt>Chrome 账号</dt><dd>{draft.original.chromeEmail || '未上报'}</dd></dl>
              {draft.original.editedBy && <div className={styles.lastEdit}>{draft.original.editor ? <UserIdentityBadge user={draft.original.editor} size="sm" /> : <span>{draft.original.editedBy}</span>}
                <span>上次修改{draft.original.editedAt > 0 && <> · <RelativeTime value={new Date(draft.original.editedAt).toISOString()} /></>}</span></div>}
            </details>
          </div>
          <footer className={styles.drawerFooter}>{saveError && <p role="alert" className={styles.note}>{saveError}</p>}
            <div><button className="btn btn-secondary" type="button" disabled={saving} onClick={closeEditor}>关闭</button>
              <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button></div></footer>
        </form>
      </aside>
    </div>}
  </div>;
}
