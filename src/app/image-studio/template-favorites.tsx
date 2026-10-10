'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Heart, MoreHorizontal, Plus, RefreshCw, Pencil, Trash2, RotateCcw } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useProductDialog } from '@/components/useProductDialog';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import { cachedReactionState, pendingReactionMutation, writeReaction, notifyTemplateFavoritesChanged, installChannel } from '@/components/content-reactions/ContentReactions';
import type { ReactionListItem, ReactionListResponse, TemplateFavoriteCommand, TemplateFavoriteMutation, TemplateFavoriteOrganization } from '@/lib/content-reactions/types';
import styles from './template-favorites.module.css';

const commandOf = (body: TemplateFavoriteMutation) => Object.fromEntries(Object.entries(body).filter(([key]) => !['viewerId', 'expectedRevision', 'requestId'].includes(key))) as TemplateFavoriteCommand;

export function useTemplateFavorites(userId: string, open: boolean) {
  const { user, hasLoadedUser } = useAppSession();
  const [items, setItems] = useState<ReactionListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [organization, setOrganization] = useState<TemplateFavoriteOrganization | null>(null);
  const [group, setGroup] = useState('all'), [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const [writing, setWriting] = useState(false), [writeError, setWriteError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [epoch, setEpoch] = useState(0), [dataScope, setDataScope] = useState('');
  const sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const pending = useRef<TemplateFavoriteMutation | null>(null), writeLock = useRef(false);
  const revision = useRef({ owner: '', value: -1 });
  const allowed = hasLoadedUser && user?.id === userId;
  const scope = allowed ? userId : '';
  const account = useRef({ scope, generation: 0 });
  if (account.current.scope !== scope) account.current = { scope, generation: account.current.generation + 1 };
  const currentScope = useRef(scope); currentScope.current = scope;
  const currentGroup = useRef(group); currentGroup.current = group;
  const view = `${scope}/${group}`;
  const filterKey = `video-api-debugger:template-favorites:${userId}:group`;
  const changeGroup = useCallback((value: string) => {
    setGroup(value);
    try { localStorage.setItem(filterKey, value); } catch { /* Filtering still works without browser storage. */ }
  }, [filterKey]);
  const load = useCallback(async (next?: string) => {
    if (!scope || !ready) return;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const serial = ++sequence.current;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ action: 'like', category: 'template', organize: '1', group, limit: '24' });
      if (next) params.set('cursor', next);
      const response = await fetch(`/api/content-reactions?${params}`, { cache: 'no-store', signal: request.signal });
      const data: ReactionListResponse & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error || '喜欢模板读取失败，请重试');
      if (request.signal.aborted || serial !== sequence.current || currentScope.current !== scope || currentGroup.current !== group) return;
      if (!data.organization || data.organization.ownerId !== scope) throw new Error('账号已变化，请重新读取');
      if (revision.current.owner === scope && data.organization.revision < revision.current.value) { setEpoch(value => value + 1); return; }
      revision.current = { owner: scope, value: data.organization.revision };
      setOrganization(data.organization);
      if (data.selectedGroup !== group) { changeGroup(data.selectedGroup || 'all'); return; }
      setDataScope(`${scope}/${group}`);
      setItems(current => next ? [...current, ...data.items.filter(item => !current.some(old => old.key === item.key))] : data.items);
      setCursor(data.nextCursor); setLoaded(true);
    } catch (cause) {
      if (!request.signal.aborted && serial === sequence.current && currentScope.current === scope) setError(cause instanceof Error ? cause.message : '喜欢模板读取失败，请重试');
    } finally { if (serial === sequence.current && currentScope.current === scope) setLoading(false); }
  }, [scope, group, ready, changeGroup]);
  useEffect(() => {
    sequence.current++; controller.current?.abort();
    setItems([]); setCursor(null); setLoaded(false); setError(''); setDataScope(''); setLoading(false);
    setOrganization(null); revision.current = { owner: scope, value: -1 };
    pending.current = null; setUnconfirmed(false); setWriteError(''); setWriting(false); setReady(false);
    let saved = 'all';
    try { saved = localStorage.getItem(filterKey) || 'all'; } catch { /* An absent preference uses all templates. */ }
    setGroup(saved === 'all' || saved === 'ungrouped' || /^[0-9a-f-]{36}$/i.test(saved) ? saved : 'all');
    setReady(true);
    return () => { sequence.current++; controller.current?.abort(); };
  }, [scope, filterKey]);
  useEffect(() => {
    installChannel();
    if (!open || !allowed || !ready) return;
    void load();
    return () => { sequence.current++; controller.current?.abort(); };
  }, [open, allowed, load, epoch, ready]);
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ userId?: string }>).detail?.userId === userId) setEpoch(value => value + 1);
    };
    const focus = () => { if (open && document.visibilityState === 'visible') setEpoch(value => value + 1); };
    window.addEventListener('sd2-reactions-changed', refresh); window.addEventListener('focus', focus);
    return () => { window.removeEventListener('sd2-reactions-changed', refresh); window.removeEventListener('focus', focus); };
  }, [userId, open]);
  const announce = () => notifyTemplateFavoritesChanged(userId);
  async function manage(command: TemplateFavoriteCommand) {
    if (!scope || currentScope.current !== scope || organization?.ownerId !== scope) throw new Error('请先读取当前账号的喜欢');
    if (writeLock.current) throw new Error('上一项正在保存，请稍等');
    const previous = pending.current;
    if (previous && JSON.stringify(command) !== JSON.stringify(commandOf(previous))) throw new Error('上一项保存结果尚未确认，请先重试该项');
    const body = previous || { ...command, viewerId: scope, expectedRevision: revision.current.value, requestId: crypto.randomUUID() };
    const generation = account.current.generation;
    pending.current = body; writeLock.current = true; setWriting(true); setWriteError('');
    try {
      const response = await fetch('/api/content-reactions/template-favorites', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (currentScope.current !== scope || account.current.generation !== generation) throw new Error('账号已变化，请重新打开我的喜欢');
      if (!response.ok) {
        if (response.status < 500) { pending.current = null; setUnconfirmed(false); if (response.status === 409) setEpoch(value => value + 1); }
        throw new Error(data.error || '保存未确认，请重试');
      }
      if (data.requestId !== body.requestId || data.organization?.ownerId !== scope) throw new Error('保存回执未确认，请重试');
      pending.current = null; setUnconfirmed(false);
      if (data.organization.revision >= revision.current.value) { revision.current = { owner: scope, value: data.organization.revision }; setOrganization(data.organization); }
      if (!['all', 'ungrouped'].includes(currentGroup.current) && !data.organization.groups.some((item: { id: string }) => item.id === currentGroup.current)) changeGroup('all');
      announce();
    } catch (cause) {
      if (currentScope.current === scope && account.current.generation === generation) { setUnconfirmed(Boolean(pending.current)); setWriteError(cause instanceof Error ? cause.message : '保存未确认，请重试'); }
      throw cause;
    } finally { writeLock.current = false; if (currentScope.current === scope && account.current.generation === generation) setWriting(false); }
  }
  async function cancelLike(item: ReactionListItem) {
    if (!scope || currentScope.current !== scope) throw new Error('账号已变化，请重新打开我的喜欢');
    if (writeLock.current || pending.current) throw new Error('请先完成上一项保存');
    const generation = account.current.generation;
    writeLock.current = true; setWriting(true); setWriteError('');
    try {
      const state = cachedReactionState(scope, item.key) || item.state;
      const unfinished = pendingReactionMutation(scope, item.key);
      const result = await writeReaction(scope, item.key, 'like', false, state);
      if (currentScope.current !== scope || account.current.generation !== generation) throw new Error('账号已变化，请重新打开我的喜欢');
      if (!result || result.liked || result.favorited) throw new Error(unfinished ? '上一项喜欢已确认，仍保留此条；再次确认可取消' : '取消结果未确认，请重试');
      setItems(current => current.filter(row => row.key !== item.key)); announce();
    } catch (cause) {
      if (currentScope.current === scope && account.current.generation === generation) {
        setWriteError(cause instanceof Error ? cause.message : '取消结果未确认，请再次点击爱心重试');
        setEpoch(value => value + 1);
      }
      throw cause;
    } finally { writeLock.current = false; if (currentScope.current === scope && account.current.generation === generation) setWriting(false); }
  }
  const visible = Boolean(scope && dataScope === view);
  return { userId: scope, items: visible ? items : [], cursor: visible ? cursor : null, organization: organization?.ownerId === scope ? organization : null, group, changeGroup,
    loading: loading || Boolean(open && allowed && !visible && !error), error, loaded: visible && loaded, allowed, writing, writeError, unconfirmed, manage, cancelLike,
    retry: async () => { const body = pending.current; if (body) await manage(commandOf(body)); },
    refresh: () => setEpoch(value => value + 1), more: () => { if (allowed && cursor && !loading) void load(cursor); } };
}

export function TemplateFavoritesList(props: { data: ReturnType<typeof useTemplateFavorites>; selected: string; busy: boolean; onSelect: (item: ReactionListItem) => void }) {
  return <FavoriteList key={props.data.userId || 'signed-out'} {...props} />;
}

function FavoriteList({ data, selected, busy, onSelect }: { data: ReturnType<typeof useTemplateFavorites>; selected: string; busy: boolean; onSelect: (item: ReactionListItem) => void }) {
  const { confirm, prompt, productDialog } = useProductDialog();
  usePageExitRisk({ unsaved: productDialog || data.unconfirmed ? ['我的喜欢尚未完成的设置'] : [], busy: data.writing ? ['我的喜欢保存'] : [] });
  const [menu, setMenu] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuPanel = useRef<HTMLDivElement>(null), menuTrigger = useRef<HTMLElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 });
  const disabled = busy || data.writing || !data.allowed || !data.organization;
  const group = data.organization?.groups.find(item => item.id === data.group);
  useEffect(() => {
    if (!menu) return;
    const trigger = panel.current?.querySelector<HTMLElement>('button[aria-expanded="true"]');
    menuTrigger.current = trigger || null;
    const rect = trigger?.getBoundingClientRect();
    const height = menuPanel.current?.offsetHeight || 200;
    if (rect) setMenuPosition({ left: Math.max(8, Math.min(rect.right - 208, window.innerWidth - 216)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)) });
    menuPanel.current?.querySelector<HTMLElement>('button, select')?.focus({ preventScroll: true });
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : event.target instanceof Node && !panel.current?.contains(event.target) && !menuPanel.current?.contains(event.target)) {
        if (event instanceof KeyboardEvent) menuTrigger.current?.focus({ preventScroll: true });
        setMenu(null);
      }
    };
    const reposition = (event: Event) => { if (!(event.target instanceof Node) || !menuPanel.current?.contains(event.target)) setMenu(null); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', close);
    window.addEventListener('scroll', reposition, true); window.addEventListener('resize', reposition);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); };
  }, [menu]);
  const name = (item: ReactionListItem) => item.personalAlias || item.content?.title || `不可用模板 · ${item.key.slice(-12)}`;
  async function renameGroup() {
    if (!group) return;
    setMenu(null);
    await prompt('分组名称', group.name, { title: '改名', confirmLabel: '保存', maxLength: 60, onSubmit: value => data.manage({ action: 'rename-group', groupId: group.id, name: value }) });
  }
  return <div ref={panel} className={styles.list} data-template-favorites aria-label="喜欢的模板" aria-busy={data.loading || data.writing || busy}>
    {data.allowed && <div className={styles.toolbar}>
      <select aria-label="喜欢分组" value={data.group} disabled={busy || data.writing} onChange={event => { setMenu(null); data.changeGroup(event.target.value); }}>
        <option value="all">全部 · {data.organization?.total ?? '—'}</option><option value="ungrouped">未分组 · {data.organization?.ungroupedCount ?? '—'}</option>
        {data.organization?.groups.map(item => <option key={item.id} value={item.id}>{item.name} · {item.count}</option>)}
      </select>
      <button type="button" title="新建分组" aria-label="新建分组" disabled={disabled || data.unconfirmed} onClick={() => { const groupId = crypto.randomUUID(); void prompt('分组名称', '', { title: '新建分组', confirmLabel: '创建', maxLength: 60, onSubmit: value => data.manage({ action: 'create-group', groupId, name: value }) }); }}><Plus size={16} /></button>
      {group && <div className={styles.menuHost}><button type="button" title="管理分组" aria-label="管理分组" aria-expanded={menu === 'group'} disabled={disabled || data.unconfirmed} onClick={() => setMenu(menu === 'group' ? null : 'group')}><MoreHorizontal size={16} /></button>
        {menu === 'group' && createPortal(<div ref={menuPanel} className={styles.menu} style={menuPosition}><button type="button" onClick={() => void renameGroup()}><Pencil size={14} />改名</button><button type="button" onClick={() => { setMenu(null); void confirm(`删除“${group.name}”？其中的模板将回到未分组，喜欢仍保留。`, { title: '删除分组', confirmLabel: '删除分组', danger: true, onSubmit: () => data.manage({ action: 'delete-group', groupId: group.id }) }); }}><Trash2 size={14} />删除分组</button></div>, document.body)}
      </div>}
    </div>}
    {data.loading && <p role="status">正在读取喜欢模板</p>}
    {!data.loading && !data.allowed && <p role="status">请登录当前账号后查看喜欢模板</p>}
    {data.error && <p role="alert">{data.error}<button type="button" title="重试读取" aria-label="重试读取" disabled={data.loading} onClick={data.refresh}><RefreshCw size={15} /></button></p>}
    {data.writeError && <p role="alert">{data.writeError}{data.unconfirmed && <button type="button" disabled={data.writing} onClick={() => void data.retry().catch(() => undefined)}>重试保存</button>}</p>}
    {data.items.map(item => <div key={item.key} className={styles.row}>
      <button type="button" className={styles.item} disabled={busy || !item.content || !item.state.available} aria-pressed={selected === item.key} title={name(item)} onClick={() => onSelect(item)}>
        <span>{name(item)}</span><small>{item.content ? item.key.startsWith('image_') ? '图片' : '视频' : '不可用 · 喜欢保留'}</small>
      </button>
      <div className={styles.menuHost}><button type="button" className={styles.rowAction} title="管理这条喜欢" aria-label={`管理${name(item)}`} disabled={disabled || data.unconfirmed} aria-expanded={menu === item.key} onClick={() => setMenu(menu === item.key ? null : item.key)}><MoreHorizontal size={16} /></button>
        {menu === item.key && createPortal(<div ref={menuPanel} className={styles.menu} style={menuPosition}>
          <label>移到分组<select aria-label="移到分组" value={item.groupId || ''} disabled={disabled} onChange={event => { const groupId = event.target.value || null; void data.manage({ action: 'move', key: item.key, groupId }).then(() => setMenu(null)).catch(() => undefined); }}><option value="">未分组</option>{data.organization?.groups.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
          <button type="button" onClick={() => { setMenu(null); void prompt('只修改我看到的名称', name(item), { title: '改名', confirmLabel: '保存', maxLength: 120, onSubmit: value => data.manage({ action: 'rename', key: item.key, name: value }) }); }}><Pencil size={14} />改名</button>
          {item.personalAlias && <button type="button" onClick={() => void data.manage({ action: 'rename', key: item.key, name: null }).then(() => setMenu(null)).catch(() => undefined)}><RotateCcw size={14} />恢复原名</button>}
        </div>, document.body)}
      </div>
      <button type="button" className={styles.heart} title="取消喜欢" aria-label={`取消喜欢${name(item)}`} disabled={busy || data.writing || data.unconfirmed} onClick={() => { setMenu(null); void confirm(`取消喜欢“${name(item)}”？模板和历史结果不会删除。`, { title: '取消喜欢', confirmLabel: '取消喜欢', danger: true, onSubmit: () => data.cancelLike(item) }); }}><Heart size={17} /></button>
    </div>)}
    {data.allowed && data.loaded && !data.loading && !data.error && !data.items.length && <p role="status">{data.group === 'all' ? '还没有喜欢的模板' : '这个分组还没有模板'}</p>}
    {data.cursor && <button type="button" className={styles.more} disabled={data.loading || busy} onClick={data.more}>加载更多</button>}
    {productDialog}
  </div>;
}
