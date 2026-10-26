'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, FileText, Home, Layers, Plus, RotateCcw, Settings2, Star, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import type { UploadedAssetPayload } from '@/lib/http/file-upload';
import { StudioStyleGroups, type StudioStyleGroupsHandle, type StudioStyleSummary } from './style-groups-view';
import { StudioSkills, type SkillSummary, type StudioSkillsHandle } from './skills-view';
import styles from './style-skill-selector.module.css';

type Category = 'all' | 'styles' | 'skills';
type Kind = Exclude<Category, 'all'>;
type Entry = { kind: 'styles'; value: StudioStyleSummary } | { kind: 'skills'; value: SkillSummary };
type Paging = { cursor: string; previous: string[]; page: number };
type Preferences = { category: Category; query: string; view: 'available' | 'selected'; scroll: number; pages: Record<Kind, Paging>; styleRecent: string[] };
type PageState<T> = { items: T[]; next: string | null; loading: boolean; read: boolean; error: string; query: string; cursor: string };
export type StudioStyleSkillSelectorHandle = { open: (category: Category) => void };
export type StudioStyleSkillSelectorProps = {
  userId: string; scope: string; selectedStyles: StudioStyleSummary[]; selectedSkills: SkillSummary[];
  onStylesChange: (next: StudioStyleSummary[]) => void; onSkillsChange: (next: SkillSummary[]) => void;
  currentImages: UploadedAssetPayload[]; maxReferences?: number; disabled?: boolean;
};
const ids = (value: unknown): string[] => Array.isArray(value) ? Array.from(new Set(value.filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))) : [];
const pageDefaults = (): Paging => ({ cursor: '', previous: [], page: 1 });
const defaults = (): Preferences => ({ category: 'all', query: '', view: 'available', scroll: 0, pages: { styles: pageDefaults(), skills: pageDefaults() }, styleRecent: [] });
const emptyPage = <T,>(): PageState<T> => ({ items: [], next: null, loading: false, read: false, error: '', query: '', cursor: '' });
const itemKey = (entry: Entry) => `${entry.kind}:${entry.value.id}`;
const typeName = (kind: Kind) => kind === 'styles' ? '风格组' : '提示词组';
function readObject(key: string): Record<string, unknown> {
  try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function readPreferences(key: string): Preferences {
  const saved = readObject(key), next = defaults();
  if (saved.category === 'all' || saved.category === 'styles' || saved.category === 'skills') next.category = saved.category;
  if (typeof saved.query === 'string') next.query = saved.query.slice(0, 160);
  if (saved.view === 'selected') next.view = 'selected';
  if (typeof saved.scroll === 'number' && Number.isFinite(saved.scroll)) next.scroll = Math.max(0, Math.min(1_000_000, saved.scroll));
  next.styleRecent = ids(saved.styleRecent).slice(0, 100);
  if (saved.pages && typeof saved.pages === 'object') for (const kind of ['styles', 'skills'] as const) {
    const page = (saved.pages as Record<string, unknown>)[kind];
    if (!page || typeof page !== 'object') continue;
    const value = page as Record<string, unknown>;
    if (typeof value.cursor === 'string' && (value.cursor === '' || ids([value.cursor]).length)) {
      next.pages[kind] = { cursor: value.cursor,
        previous: Array.isArray(value.previous) ? value.previous.filter((cursor): cursor is string => typeof cursor === 'string' && (cursor === '' || ids([cursor]).length > 0)).slice(-20) : [],
        page: typeof value.page === 'number' && Number.isSafeInteger(value.page) && value.page > 0 ? value.page : 1 };
    }
  }
  return next;
}
async function readPage(kind: Kind, query: string, cursor = '', keys?: string[], signal?: AbortSignal) {
  const params = new URLSearchParams({ page: '1', query });
  if (cursor) params.set('cursor', cursor);
  if (keys) params.set('keys', keys.join(','));
  const response = await fetch(`/api/image-studio/${kind === 'styles' ? 'style-groups' : 'skills'}?${params}`, { cache: 'no-store', signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `${typeName(kind)}读取失败，请重试`);
  return { items: (kind === 'styles' ? data.groups : data.skills) as StudioStyleSummary[] | SkillSummary[], next: data.nextCursor as string | null };
}

export const StudioStyleSkillSelector = forwardRef<StudioStyleSkillSelectorHandle, StudioStyleSkillSelectorProps>(function StudioStyleSkillSelector({ userId, scope, selectedStyles, selectedSkills, onStylesChange, onSkillsChange, currentImages, maxReferences = MAX_REFERENCE_IMAGES, disabled = false }, ref) {
  const identity = `${userId}:${scope}`, key = `sd2:studio-style-skills:v1:${encodeURIComponent(userId)}:${encodeURIComponent(scope)}`, legacyKey = `sd2:skills:v1:${userId}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const [initialized, setInitialized] = useState(''), [preferences, setPreferences] = useState<Preferences>(defaults);
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const [open, setOpen] = useState(false), [detail, setDetail] = useState<Entry | null>(null);
  const [manager, setManager] = useState<'menu' | Kind | null>(null);
  const [stylePage, setStylePage] = useState<PageState<StudioStyleSummary>>(emptyPage), [skillPage, setSkillPage] = useState<PageState<SkillSummary>>(emptyPage);
  const [recent, setRecent] = useState<Entry[]>([]), [recentError, setRecentError] = useState('');
  const [recentLoading, setRecentLoading] = useState(false);
  const [likes, setLikes] = useState<string[]>([]), [skillRecent, setSkillRecent] = useState<string[]>([]);
  const [message, setMessage] = useState(''), [retry, setRetry] = useState({ styles: 0, skills: 0, recent: 0 });
  const dialog = useRef<HTMLDialogElement>(null), details = useRef<HTMLDialogElement>(null), body = useRef<HTMLDivElement>(null);
  const styleManager = useRef<StudioStyleGroupsHandle>(null), skillManager = useRef<StudioSkillsHandle>(null);
  const pendingScroll = useRef<number | null>(null), scroll = useRef(0), scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequences = useRef({ styles: 0, skills: 0, recent: 0 });
  const refreshLegacy = useCallback(() => {
    const saved = readObject(legacyKey); setLikes(ids(saved.likes)); setSkillRecent(ids(saved.recent).slice(0, 100));
  }, [legacyKey]);
  const closeManager = useCallback(() => { setManager(null); refreshLegacy(); }, [refreshLegacy]);
  const savePreferences = useCallback(() => {
    if (currentIdentity.current !== identity || initialized !== key) return;
    try { localStorage.setItem(key, JSON.stringify({ ...preferencesRef.current, scroll: scroll.current })); } catch { /* Selection is independent of optional preferences. */ }
  }, [identity, initialized, key]);
  useEffect(() => {
    sequences.current.styles++; sequences.current.skills++; sequences.current.recent++;
    const saved = readPreferences(key); setPreferences(saved); scroll.current = saved.scroll;
    setOpen(false); setDetail(null); setManager(null); setStylePage(emptyPage()); setSkillPage(emptyPage()); setRecent([]); setMessage('');
    refreshLegacy(); setInitialized(key);
    return () => { sequences.current.styles++; sequences.current.skills++; sequences.current.recent++; if (scrollTimer.current) clearTimeout(scrollTimer.current); };
  }, [key, refreshLegacy]);
  useEffect(() => { savePreferences(); }, [preferences, savePreferences]);
  useEffect(() => {
    const flush = () => savePreferences(); window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); savePreferences(); };
  }, [savePreferences]);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => { if (detail) details.current?.showModal(); else details.current?.close(); }, [Boolean(detail)]);
  const show = (category?: Category) => {
    if (initialized !== key) return;
    if (category) {
      const changed = preferences.category !== category;
      setPreferences(current => ({ ...current, category, view: 'available', scroll: changed ? 0 : current.scroll }));
      pendingScroll.current = changed ? 0 : scroll.current;
    } else pendingScroll.current = scroll.current;
    setMessage(''); setOpen(true);
  };
  useImperativeHandle(ref, () => ({ open: category => show(category) }));
  const close = () => {
    if (detail || manager === 'styles' || manager === 'skills') return;
    if (manager === 'menu') { setManager(null); return; }
    savePreferences(); setOpen(false);
  };
  useDialogDismiss({ open, dialogRef: dialog, nativeDialog: true, onDismiss: close });
  useDialogDismiss({ open: Boolean(detail), dialogRef: details, nativeDialog: true, onDismiss: () => setDetail(null) });

  const query = preferences.query, styleCursor = preferences.pages.styles.cursor, skillCursor = preferences.pages.skills.cursor;
  useEffect(() => {
    if (!open || initialized !== key) return;
    const actor = identity, controller = new AbortController(), token = ++sequences.current.styles;
    setStylePage(current => ({ ...current, loading: true, error: '' }));
    const timer = setTimeout(() => { void readPage('styles', query, styleCursor, undefined, controller.signal).then(result => {
      if (currentIdentity.current === actor && sequences.current.styles === token) setStylePage({ items: result.items as StudioStyleSummary[], next: result.next, loading: false, read: true, error: '', query, cursor: styleCursor });
    }).catch(error => { if (!controller.signal.aborted && currentIdentity.current === actor && sequences.current.styles === token) setStylePage(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : '风格组读取失败' })); }); }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, initialized, key, identity, query, styleCursor, retry.styles]);
  useEffect(() => {
    if (!open || initialized !== key) return;
    const actor = identity, controller = new AbortController(), token = ++sequences.current.skills;
    setSkillPage(current => ({ ...current, loading: true, error: '' }));
    const timer = setTimeout(() => { void readPage('skills', query, skillCursor, undefined, controller.signal).then(result => {
      if (currentIdentity.current === actor && sequences.current.skills === token) setSkillPage({ items: result.items as SkillSummary[], next: result.next, loading: false, read: true, error: '', query, cursor: skillCursor });
    }).catch(error => { if (!controller.signal.aborted && currentIdentity.current === actor && sequences.current.skills === token) setSkillPage(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : '提示词组读取失败' })); }); }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, initialized, key, identity, query, skillCursor, retry.skills]);
  const recentStyles = preferences.styleRecent.slice(0, 8).join(','), recentSkills = skillRecent.slice(0, 8).join(',');
  useEffect(() => {
    if (!open || initialized !== key) return;
    const actor = identity, controller = new AbortController(), token = ++sequences.current.recent;
    setRecentError(''); setRecentLoading(true);
    const timer = setTimeout(() => { void Promise.allSettled([
      readPage('styles', query, '', recentStyles ? recentStyles.split(',') : [], controller.signal),
      readPage('skills', query, '', recentSkills ? recentSkills.split(',') : [], controller.signal),
    ]).then(results => {
      if (controller.signal.aborted || currentIdentity.current !== actor || sequences.current.recent !== token) return;
      const entries: Entry[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const kind: Kind = index === 0 ? 'styles' : 'skills';
          for (const value of result.value.items) entries.push(kind === 'styles' ? { kind, value: value as StudioStyleSummary } : { kind, value: value as SkillSummary });
        }
      });
      entries.sort((a, b) => {
        const rank = (entry: Entry) => (entry.kind === 'styles' ? recentStyles.split(',') : recentSkills.split(',')).indexOf(entry.value.id);
        return rank(a) - rank(b);
      });
      setRecent(entries);
      setRecentLoading(false);
      if (results.some(result => result.status === 'rejected')) setRecentError('部分最近使用内容未能读取，其他列表仍可使用');
    }); }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, initialized, key, identity, query, recentStyles, recentSkills, retry.recent]);
  useLayoutEffect(() => {
    if (!open || detail || manager || pendingScroll.current === null) return;
    if (preferences.view !== 'selected' && (stylePage.loading || skillPage.loading || recentLoading
      || !(stylePage.read || stylePage.error) || !(skillPage.read || skillPage.error))) return;
    if (body.current) { body.current.scrollTop = pendingScroll.current; scroll.current = body.current.scrollTop; }
    pendingScroll.current = null;
  }, [open, detail, manager, stylePage.loading, stylePage.read, stylePage.error, skillPage.loading, skillPage.read, skillPage.error, recentLoading, preferences.view]);

  const cap = Number.isFinite(maxReferences) ? Math.max(0, Math.min(MAX_REFERENCE_IMAGES, maxReferences)) : MAX_REFERENCE_IMAGES;
  const imageCount = selectedStyles.reduce((sum, group) => sum + group.referenceCount, 0);
  const selected: Entry[] = [...selectedStyles.map(value => ({ kind: 'styles' as const, value })), ...selectedSkills.map(value => ({ kind: 'skills' as const, value }))];
  const used = (entry: Entry) => (entry.kind === 'styles' ? selectedStyles : selectedSkills).some(item => item.id === entry.value.id);
  function rememberSkills(nextLikes: string[], nextRecent: string[]) {
    setLikes(nextLikes); setSkillRecent(nextRecent);
    try { localStorage.setItem(legacyKey, JSON.stringify({ ...readObject(legacyKey), likes: nextLikes, recent: nextRecent })); }
    catch { setMessage('本机无法记住常用与最近选择，当前选用不受影响'); }
  }
  function toggle(entry: Entry) {
    if (disabled) return;
    const isUsed = used(entry);
    if (entry.kind === 'styles') {
      if (!isUsed && (entry.value.unavailable || imageCount + entry.value.referenceCount > cap || selectedStyles.length >= MAX_REFERENCE_IMAGES)) { setMessage(`风格图片最多可选 ${cap} 张，当前已选 ${imageCount} 张`); return; }
      onStylesChange(isUsed ? selectedStyles.filter(item => item.id !== entry.value.id) : [...selectedStyles, entry.value]);
      if (!isUsed) setPreferences(current => ({ ...current, styleRecent: [entry.value.id, ...current.styleRecent.filter(id => id !== entry.value.id)].slice(0, 100) }));
    } else {
      if (!isUsed && (entry.value.unavailable || selectedSkills.length >= 12)) { setMessage(entry.value.unavailable ? '这个提示词组已不可用，请重新选择' : '最多选用 12 个提示词组'); return; }
      onSkillsChange(isUsed ? selectedSkills.filter(item => item.id !== entry.value.id) : [...selectedSkills, entry.value]);
      if (!isUsed) rememberSkills(likes, [entry.value.id, ...skillRecent.filter(id => id !== entry.value.id)].slice(0, 100));
    }
    setMessage('');
  }
  function moveSkill(id: string, direction: number) {
    if (disabled) return;
    const next = [...selectedSkills], index = next.findIndex(item => item.id === id), destination = index + direction;
    if (index < 0 || destination < 0 || destination >= next.length) return;
    [next[index], next[destination]] = [next[destination], next[index]]; onSkillsChange(next);
  }
  function updateFilter(change: Partial<Pick<Preferences, 'query' | 'category' | 'view'>>) {
    scroll.current = 0; pendingScroll.current = 0;
    setPreferences(current => ({ ...current, ...change, scroll: 0, pages: change.query === undefined ? current.pages : { styles: pageDefaults(), skills: pageDefaults() } }));
  }
  function changePage(kind: Kind, action: 'next' | 'previous' | 'home') {
    scroll.current = 0; pendingScroll.current = 0;
    const state = kind === 'styles' ? stylePage : skillPage;
    setPreferences(current => {
      const previous = current.pages[kind]; let next = pageDefaults();
      if (action === 'next' && state.next) next = { cursor: state.next, previous: [...previous.previous, previous.cursor].slice(-20), page: previous.page + 1 };
      else if (action === 'previous' && previous.previous.length) next = { cursor: previous.previous.at(-1) || '', previous: previous.previous.slice(0, -1), page: Math.max(1, previous.page - 1) };
      return { ...current, scroll: 0, pages: { ...current.pages, [kind]: next } };
    });
  }
  function card(entry: Entry) {
    const isUsed = used(entry), excessive = !isUsed && (entry.kind === 'styles' ? imageCount + entry.value.referenceCount > cap || selectedStyles.length >= MAX_REFERENCE_IMAGES : selectedSkills.length >= 12);
    return <article className={styles.card} key={itemKey(entry)} data-selected={isUsed || undefined}>
      <button type="button" className={styles.selectCard} disabled={disabled || excessive || Boolean(entry.value.unavailable)} aria-pressed={isUsed} onClick={() => toggle(entry)}>
        <span className={styles.cover}>{entry.value.coverUrl ? <img src={entry.value.coverUrl} alt="" loading="lazy" /> : entry.kind === 'styles' ? <Layers size={28} /> : <FileText size={28} />}{isUsed && <Check className={styles.check} size={20} />}</span>
        <strong>{entry.value.name}</strong><small>{typeName(entry.kind)}{entry.kind === 'styles' ? ` · ${entry.value.referenceCount} 张参考图` : ''}</small>
        {entry.kind === 'skills' && entry.value.prompt && <span className={styles.summary}>{entry.value.prompt.trim().split('\n')[0].slice(0, 140)}</span>}
      </button>
      <div className={styles.cardActions}><button type="button" onClick={() => setDetail(entry)}>详情</button>{entry.kind === 'skills' && <button type="button" title={likes.includes(entry.value.id) ? '取消本机常用' : '设为本机常用'} aria-label={`${likes.includes(entry.value.id) ? '取消' : '设为'}本机常用提示词组`} aria-pressed={likes.includes(entry.value.id)} onClick={() => rememberSkills(likes.includes(entry.value.id) ? likes.filter(id => id !== entry.value.id) : [...likes, entry.value.id], skillRecent)}><Star size={16} fill={likes.includes(entry.value.id) ? 'currentColor' : 'none'} /></button>}</div>
      {excessive && <small className={styles.limit}>{entry.kind === 'styles' ? `剩余 ${Math.max(0, cap - imageCount)} 张风格图片额度` : '已选满 12 个提示词组'}</small>}
    </article>;
  }
  function list(kind: Kind) {
    const state = kind === 'styles' ? stylePage : skillPage, paging = preferences.pages[kind];
    const currentPage = state.read && state.query === query && state.cursor === paging.cursor;
    const entries = state.items.map(value => kind === 'styles' ? { kind, value: value as StudioStyleSummary } : { kind, value: value as SkillSummary }) as Entry[];
    const recentKeys = new Set(recent.map(itemKey));
    return <section className={styles.listSection} key={kind} aria-label={typeName(kind)}>
      <header className={styles.sectionHeader}><strong>{typeName(kind)}</strong><span>{state.loading ? '正在读取…' : currentPage ? `第 ${paging.page} 页` : state.error ? '保留上次成功结果' : '等待读取'}</span></header>
      {state.error && <p className={styles.error} role="alert">{state.error}，以下保留上次成功读取的内容，当前已选不变。<button type="button" onClick={() => setRetry(current => ({ ...current, [kind]: current[kind] + 1 }))}>重试{typeName(kind)}</button></p>}
      <div className={styles.grid}>{entries.filter(entry => !recentKeys.has(itemKey(entry))).map(card)}</div>
      {!state.loading && !state.error && currentPage && !state.items.length && <p className={styles.muted}>{query ? '本页没有匹配内容' : '本页暂无可用内容'}{paging.page > 1 ? '，可回到上一页或首页' : ''}</p>}
      {(paging.page > 1 || state.next) && <nav className={styles.pagination} aria-label={`${typeName(kind)}翻页`}><button type="button" disabled={state.loading || paging.page === 1} title="回到首页" aria-label={`${typeName(kind)}首页`} onClick={() => changePage(kind, 'home')}><Home size={16} /></button><button type="button" disabled={state.loading || Boolean(state.error) || !currentPage || !paging.previous.length} aria-label={`${typeName(kind)}上一页`} onClick={() => changePage(kind, 'previous')}><ChevronLeft size={16} /></button><span>{currentPage ? paging.page : '—'}</span><button type="button" disabled={state.loading || Boolean(state.error) || !currentPage || !state.next} aria-label={`${typeName(kind)}下一页`} onClick={() => changePage(kind, 'next')}><ChevronRight size={16} /></button></nav>}
    </section>;
  }
  const styleUpdated = () => { pendingScroll.current = scroll.current; setRetry(current => ({ ...current, styles: current.styles + 1, recent: current.recent + 1 })); };
  const skillUpdated = () => { pendingScroll.current = scroll.current; setRetry(current => ({ ...current, skills: current.skills + 1, recent: current.recent + 1 })); };
  if (initialized !== key) return null;
  return <div className={styles.root}>
    {selected.length > 0 && <div className={styles.selectedChips}>{selected.map(entry => <span className={styles.chip} key={itemKey(entry)} data-unavailable={entry.value.unavailable || undefined}><button type="button" title={`查看${entry.value.name}`} aria-label={`查看${typeName(entry.kind)}：${entry.value.name}`} onClick={() => setDetail(entry)}>{entry.value.coverUrl && <img src={entry.value.coverUrl} alt="" />}<span className={styles.chipLabel}><span>{entry.value.name}</span><small>{typeName(entry.kind)}{entry.value.unavailable ? ' · 不可用' : ''}</small></span></button><button type="button" className={styles.removeChip} title="取消选用" aria-label={`取消选用${entry.value.name}`} disabled={disabled} onClick={() => toggle(entry)}><X size={14} /></button></span>)}</div>}
    <button type="button" className={styles.addTile} title="选择风格组或提示词组" aria-label="添加风格组或提示词组" disabled={disabled} onClick={() => show()}><Plus size={24} /><span>添加风格组</span></button>
    <dialog ref={dialog} className={styles.dialog} aria-label="添加风格与提示词">
      <header className={styles.dialogHeader}><h2>添加风格与提示词</h2><button type="button" aria-label="关闭选择" disabled={Boolean(detail) || manager === 'styles' || manager === 'skills'} onClick={close}><X size={20} /></button></header>
      <div className={styles.filters}><input aria-label="搜索风格组或提示词组名称及可查看说明" placeholder="搜索名称或说明" maxLength={160} value={query} onChange={event => updateFilter({ query: event.target.value })} /><button type="button" title="重置筛选与位置" aria-label="重置筛选与位置" onClick={() => { scroll.current = 0; pendingScroll.current = 0; setPreferences(current => ({ ...defaults(), styleRecent: current.styleRecent })); }}><RotateCcw size={16} /></button><button type="button" disabled={disabled} onClick={() => setManager(value => value === 'menu' ? null : 'menu')}><Settings2 size={16} />管理</button></div>
      <div className={styles.categories} role="group" aria-label="内容类型">{(['all', 'styles', 'skills'] as const).map(category => <button type="button" aria-pressed={preferences.category === category && preferences.view === 'available'} key={category} onClick={() => updateFilter({ category, view: 'available' })}>{category === 'all' ? '全部' : typeName(category)}</button>)}</div>
      {manager === 'menu' && <div className={styles.manageMenu}><button type="button" onClick={() => { setManager('styles'); styleManager.current?.open(); }}>管理风格组</button><button type="button" onClick={() => { setManager('skills'); skillManager.current?.open(); }}>管理提示词组</button><small>新建、编辑、复制、删除与合并在对应管理中完成。</small></div>}
      <div ref={body} className={styles.body} onScroll={event => { scroll.current = event.currentTarget.scrollTop; if (scrollTimer.current) clearTimeout(scrollTimer.current); scrollTimer.current = setTimeout(savePreferences, 200); }}>
        {message && <p role="status" className={styles.error}>{message}</p>}
        {preferences.view === 'selected' ? <section><div className={styles.sectionHeader}><strong>当前已选</strong><button type="button" onClick={() => updateFilter({ view: 'available' })}>返回选择</button></div>{selected.map(entry => <div className={styles.selectedRow} key={itemKey(entry)}><button type="button" title={`查看${entry.value.name}`} aria-label={`查看${typeName(entry.kind)}：${entry.value.name}`} onClick={() => setDetail(entry)}>{entry.value.name}<small>{typeName(entry.kind)}{entry.value.unavailable ? ' · 不可用，请处理' : ''}</small></button>{entry.kind === 'skills' && <><button type="button" title="前移提示词组" aria-label={`前移${entry.value.name}`} disabled={disabled || selectedSkills[0]?.id === entry.value.id} onClick={() => moveSkill(entry.value.id, -1)}><ArrowUp size={16} /></button><button type="button" title="后移提示词组" aria-label={`后移${entry.value.name}`} disabled={disabled || selectedSkills.at(-1)?.id === entry.value.id} onClick={() => moveSkill(entry.value.id, 1)}><ArrowDown size={16} /></button></>}<button type="button" title="取消选用" aria-label={`取消选用${entry.value.name}`} disabled={disabled} onClick={() => toggle(entry)}><X size={16} /></button></div>)}{!selected.length && <p className={styles.muted}>尚未选用内容。</p>}</section> : <>
          {recent.filter(entry => preferences.category === 'all' || entry.kind === preferences.category).length > 0 && <section><h3>最近使用</h3><div className={styles.grid}>{recent.filter(entry => preferences.category === 'all' || entry.kind === preferences.category).map(card)}</div></section>}
          {recentError && <p className={styles.error} role="status">{recentError}<button type="button" onClick={() => setRetry(current => ({ ...current, recent: current.recent + 1 }))}>重试最近使用</button></p>}
          {(preferences.category === 'all' || preferences.category === 'styles') && list('styles')}{(preferences.category === 'all' || preferences.category === 'skills') && list('skills')}
        </>}
      </div>
      <footer className={styles.footer}><div><button type="button" onClick={() => updateFilter({ view: 'selected' })}>已选 {selected.length} 项 · 查看</button><small>风格组 {selectedStyles.length} · 提示词组 {selectedSkills.length}/12 · 风格图片 {imageCount}/{cap} 张</small><small>选择会立即更新当前设置，模板保存沿原入口。</small></div><button type="button" className={styles.primary} disabled={Boolean(detail) || manager === 'styles' || manager === 'skills'} onClick={close}>完成</button></footer>
    </dialog>
    <dialog ref={details} className={`${styles.dialog} ${styles.details}`} aria-label="查看已选内容"><header className={styles.dialogHeader}><h2>{detail?.value.name}</h2><button type="button" aria-label="关闭详情" onClick={() => setDetail(null)}><X size={20} /></button></header>{detail && <div className={styles.detailBody}><p className={styles.muted}>{typeName(detail.kind)}{detail.value.unavailable ? ' · 已不可用，当前选择保留，请移除或重新选择' : ''}</p>{detail.value.coverUrl && !detail.value.unavailable && <img className={styles.detailCover} src={detail.value.coverUrl} alt={`${detail.value.name}封面`} />}{detail.kind === 'skills' ? <><pre>{detail.value.prompt || '当前未提供文字内容，请在管理中查看。'}</pre><button type="button" disabled={disabled || !detail.value.prompt} onClick={() => { const group = detail.value as SkillSummary; setDetail(null); setManager('skills'); skillManager.current?.edit(group, true); }}>保存文字副本</button>{!detail.value.unavailable && <button type="button" disabled={disabled} onClick={() => { const group = detail.value as SkillSummary; setDetail(null); setManager('skills'); skillManager.current?.edit(group); }}>编辑提示词组</button>}</> : <><p>{detail.value.referenceCount} 张风格参考图</p>{detail.value.canManage && !detail.value.unavailable && <><p>{detail.value.note || '未填写整体备注'}</p><div className={styles.referenceImages}>{detail.value.references?.map(reference => reference.thumbnailUrl && <figure key={reference.id}><img src={reference.thumbnailUrl} alt="风格参考图" /><figcaption>{reference.note}</figcaption></figure>)}</div><button type="button" disabled={disabled} onClick={() => { const group = detail.value as StudioStyleSummary; setDetail(null); setManager('styles'); styleManager.current?.edit(group); }}>编辑风格组</button></>}</>}</div>}</dialog>
    <StudioStyleGroups key={`styles:${identity}`} ref={styleManager} userId={userId} selected={selectedStyles} onChange={onStylesChange} currentImages={currentImages} maxReferences={cap} disabled={disabled} managementOnly onUpdated={styleUpdated} onClose={closeManager} />
    <StudioSkills key={`skills:${identity}`} ref={skillManager} userId={userId} selected={selectedSkills} onChange={onSkillsChange} disabled={disabled} managementOnly onUpdated={skillUpdated} onClose={closeManager} />
  </div>;
});
