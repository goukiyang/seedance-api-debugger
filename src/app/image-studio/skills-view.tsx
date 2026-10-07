'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Copy, FileText, Star, Pencil, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { useProductDialog } from '@/components/useProductDialog';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import styles from './studio.module.css';
export type SkillSummary = { id: string; name: string; revision?: number; prompt?: string; promptVersion?: string;
  coverAssetId?: string | null; coverUrl?: string | null; unavailable?: boolean };
async function value(response: Response) { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'skills操作失败'); return data; }
export function StudioSkills({ userId, selected, onChange, disabled }: { userId: string; selected: SkillSummary[];
  onChange: (next: SkillSummary[]) => void; disabled?: boolean }) {
  const { confirm, productDialog } = useProductDialog();
  const [open, setOpen] = useState(false), [groups, setGroups] = useState<SkillSummary[]>([]);
  const [draft, setDraft] = useState<SkillSummary | null>(null), [saved, setSaved] = useState('');
  const [query, setQuery] = useState(''), [view, setView] = useState('all');
  const [visible, setVisible] = useState(48);
  const [initialized, setInitialized] = useState(''), [phase, setPhase] = useState('');
  const [likes, setLikes] = useState<string[]>([]), [recent, setRecent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [picker, setPicker] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), editor = useRef<HTMLDialogElement>(null), serial = useRef(0);
  const key = `sd2:skills:v1:${userId}`;
  useEffect(() => {
    serial.current++; setOpen(false); setDraft(null); setGroups([]); setLikes([]); setRecent([]); setBusy(false); setError(''); setPicker(false); setQuery(''); setView('all');
    try { const data = JSON.parse(localStorage.getItem(key) || '{}');
      const ids = (v: unknown) => Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) : [];
      setLikes(ids(data.likes)); setRecent(ids(data.recent));
      if (typeof data.query === 'string') setQuery(data.query.slice(0, 160));
      if (['all', 'liked', 'recent'].includes(data.view)) setView(data.view);
    } catch { /* Optional preferences cannot block selection. */ }
    setInitialized(key);
  }, [key]);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const editing = Boolean(draft);
  useEffect(() => { if (editing) editor.current?.showModal(); else editor.current?.close(); }, [editing]);
  useEffect(() => setVisible(48), [key, query, view]);
  useEffect(() => { if (initialized !== key) return; try { localStorage.setItem(key, JSON.stringify({ likes, recent, query, view })); } catch { /* Selection does not depend on local preferences. */ } }, [initialized, key, likes, recent, query, view]);
  function remember(nextLikes: string[], nextRecent: string[]) { setLikes(nextLikes); setRecent(nextRecent);
    try { localStorage.setItem(key, JSON.stringify({ likes: nextLikes, recent: nextRecent, query, view })); } catch { setError('本机无法记住喜欢与最近选择，当前选用不受影响'); } }
  const closeEditor = async () => { if (busy || picker) return; if (draft && JSON.stringify(draft) !== saved
    && !await confirm('skills尚未保存，放弃这次修改？', { title: '放弃修改', confirmLabel: '放弃修改' })) return; setDraft(null); };
  useDialogDismiss({ open, dialogRef: dialog, nativeDialog: true, onDismiss: () => { if (!busy && !draft) setOpen(false); } });
  useDialogDismiss({ open: Boolean(draft), dialogRef: editor, nativeDialog: true, onDismiss: closeEditor });
  async function load() { const token = ++serial.current; setBusy(true); setPhase('reading'); setError('');
    try { const data = await value(await fetch('/api/image-studio/skills', { cache: 'no-store' })); if (token === serial.current) setGroups(data.skills); }
    catch (cause) { if (token === serial.current) setError((cause as Error).message); }
    finally { if (token === serial.current) setBusy(false); }
  }
  function edit(group?: SkillSummary, duplicate = false) {
    const next = group ? { ...group, ...(duplicate ? { id: '', revision: undefined, name: `${group.name}副本` } : {}) }
      : { id: '', name: '', prompt: '', coverAssetId: null, coverUrl: null };
    setDraft(next); setSaved(JSON.stringify(next)); setError('');
  }
  async function save() { if (!draft || busy) return; const token = serial.current; setBusy(true); setPhase('saving'); setError('');
    try { const next = await value(await fetch('/api/image-studio/skills', { method: draft.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, id: draft.id || undefined }) }));
      if (token !== serial.current) return;
      setGroups(current => [next, ...current.filter(group => group.id !== next.id)]);
      onChange(selected.map(group => group.id === next.id ? next : group)); setDraft(null);
    } catch (cause) { if (token === serial.current) setError((cause as Error).message); }
    finally { if (token === serial.current) setBusy(false); }
  }
  async function remove(group: SkillSummary) { if (busy || !await confirm(`删除“${group.name}”？历史文字和封面原件保留。`, { title: '删除skills', confirmLabel: '删除', danger: true })) return;
    const token = serial.current;
    setBusy(true); try { await value(await fetch('/api/image-studio/skills', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: group.id, revision: group.revision }) }));
      if (token !== serial.current) return;
      setGroups(current => current.filter(item => item.id !== group.id));
      onChange(selected.map(item => item.id === group.id ? { ...item, unavailable: true } : item));
    } catch (cause) { if (token === serial.current) setError((cause as Error).message); } finally { if (token === serial.current) setBusy(false); }
  }
  async function uploadCover(file?: File) {
    if (!draft || !file || busy) return;
    if (!file.type.startsWith('image/')) { setError('请选择图片封面'); return; }
    const token = serial.current; setBusy(true); setPhase('uploading'); setError('');
    try {
      const asset = await uploadFileAsAsset(file);
      if (token !== serial.current) return;
      if (!asset.id) throw new Error('封面上传尚未确认，请重试');
      setDraft(current => current ? { ...current, coverAssetId: asset.id, coverUrl: `/api/content-reactions/media?key=${encodeURIComponent(`asset:${asset.id}`)}&variant=thumbnail` } : current);
    } catch (cause) { if (token === serial.current) setError((cause as Error).message); }
    finally { if (token === serial.current) setBusy(false); }
  }
  function toggle(group: SkillSummary) {
    const used = selected.some(item => item.id === group.id);
    if (disabled || busy || !used && selected.length >= 12) return;
    onChange(used ? selected.filter(item => item.id !== group.id) : [...selected, group]);
    if (!used) remember(likes, [group.id, ...recent.filter(id => id !== group.id)].slice(0, 100));
  }
  function move(index: number, direction: number) { const next = [...selected], to = index + direction; if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]]; onChange(next); }
  const filtered = groups.filter(group => (view !== 'liked' || likes.includes(group.id)) && (view !== 'recent' || recent.includes(group.id))
    && `${group.name}\n${group.prompt || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (view === 'recent') filtered.sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id));
  if (initialized !== key) return null;
  return <>{productDialog}<div className={styles.styleGroupsTiles}><div className={styles.materialGrid}>
    {selected.map((group, index) => <div className={styles.styleTile} key={group.id}>
      <button type="button" className={styles.styleTilePreview} disabled={disabled} onClick={() => { setOpen(true); void load(); }} title={group.name}><FileText size={24} />{group.coverUrl && <img src={group.coverUrl} alt="" />}<span className={styles.styleTileName}>{group.unavailable ? 'skills不可用' : group.name}</span></button>
      <button type="button" className={styles.materialRemove} disabled={disabled} title="移除skills" onClick={() => onChange(selected.filter(item => item.id !== group.id))}><X size={14} /></button>
      <div className={styles.skillOrder}><button title="前移" aria-label="前移skills" disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowLeft size={12} /></button><button title="后移" aria-label="后移skills" disabled={disabled || index === selected.length - 1} onClick={() => move(index, 1)}><ArrowRight size={12} /></button>{group.prompt && <button title="保存文字副本" aria-label="保存skills文字副本" disabled={disabled} onClick={() => { setOpen(true); edit(group, true); }}><Copy size={12} /></button>}</div>
    </div>)}<button type="button" className={styles.materialAdd} disabled={disabled} onClick={() => { setOpen(true); void load(); }}><Plus size={24} /><span>选择skills</span></button>
  </div></div>
  <dialog ref={dialog} className={`${styles.dialog} ${styles.styleDialog}`} aria-label="skills">
    <header className={styles.header}><h2>skills</h2><button title="关闭" aria-label="关闭skills" disabled={busy || Boolean(draft)} onClick={() => setOpen(false)}><X size={20} /></button></header>
    <div className={styles.counts}><input aria-label="搜索skills" placeholder="搜索" maxLength={160} value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="skills范围" value={view} onChange={event => setView(event.target.value)}><option value="all">全部</option><option value="liked">本机常用</option><option value="recent">本机最近使用</option></select><button title="重置skills筛选" aria-label="重置skills筛选" onClick={() => { setQuery(''); setView('all'); }}><RotateCcw size={16} /></button><button onClick={() => edit()} disabled={busy}><Plus size={16} />新建skills</button></div>
    {busy && <p role="status">正在处理…</p>}{error && <p role="alert" className={styles.error}>{error}<button onClick={() => void load()}>重试读取</button></p>}
    <div className={styles.styleGrid}>{filtered.slice(0, visible).map(group => <article key={group.id} className={styles.styleCard} data-selected={selected.some(item => item.id === group.id) || undefined}>
      <button className={styles.styleSelect} disabled={disabled || busy} aria-pressed={selected.some(item => item.id === group.id)} onClick={() => toggle(group)}><span className={styles.styleCover}>{group.coverUrl ? <img src={group.coverUrl} alt="" loading="lazy" /> : <FileText size={32} />}</span><strong>{group.name}</strong></button>
      <div className={styles.styleActions}><button title={likes.includes(group.id) ? '取消本机常用' : '设为本机常用'} aria-label={likes.includes(group.id) ? '取消本机常用skills' : '设为本机常用skills'} aria-pressed={likes.includes(group.id)} onClick={() => remember(likes.includes(group.id) ? likes.filter(id => id !== group.id) : [...likes, group.id], recent)}><Star size={16} fill={likes.includes(group.id) ? 'currentColor' : 'none'} /></button><button title="编辑" aria-label="编辑skills" onClick={() => edit(group)}><Pencil size={16} /></button><button title="复制" aria-label="复制skills" onClick={() => edit(group, true)}><Copy size={16} /></button><button title="删除" aria-label="删除skills" onClick={() => void remove(group)}><Trash2 size={16} /></button></div>
    </article>)}</div>{visible < filtered.length && <button onClick={() => setVisible(count => count + 48)}>加载更多</button>}{!busy && !error && !filtered.length && <p>暂无skills</p>}
  </dialog>
  <dialog ref={editor} className={`${styles.dialog} ${styles.styleDialog}`} aria-label="编辑skills">
    {draft && <><header className={styles.header}><h2>{draft.id ? '编辑skills' : '新建skills'}</h2><button title="关闭" aria-label="关闭编辑" disabled={busy} onClick={() => void closeEditor()}><X size={20} /></button></header>
      <label>名称<input value={draft.name} maxLength={80} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>提示词<textarea value={draft.prompt || ''} maxLength={8000} rows={8} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label>
      <div className={styles.skillCover} tabIndex={0} aria-label="封面，仅展示" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void uploadCover(event.dataTransfer.files[0]); }} onPaste={event => { const file = Array.from(event.clipboardData.files).find(item => item.type.startsWith('image/')); if (file) { event.preventDefault(); void uploadCover(file); } }}><button onClick={() => setPicker(true)} disabled={busy}><Plus size={16} />封面<span>仅展示</span></button>{draft.coverUrl && <img src={draft.coverUrl} alt="封面" width={64} height={64} />}{draft.coverAssetId && <button title="移除封面" aria-label="移除封面" disabled={busy} onClick={() => setDraft({ ...draft, coverAssetId: null, coverUrl: null })}><X size={16} /></button>}</div>
      {phase === 'uploading' && busy && <p role="status">封面正在上传，文字尚未保存</p>}{error && <p role="alert" className={styles.error}>{error}</p>}<button className={styles.primary} disabled={busy || !draft.prompt?.trim()} onClick={() => void save()}><Save size={16} />{busy && phase === 'saving' ? '保存中…' : '保存'}</button>
    </>}
  </dialog>
  <ResourceLibraryPicker open={picker} imageOnly target="image-studio" purpose="skills-cover" title="选择封面" confirmLabel="设为封面" maxSelection={1} currentCount={0} currentAssetIds={[]} onClose={() => setPicker(false)} onUploadFile={file => uploadFileAsAsset(file)} onConfirm={async (ids) => { if (draft && ids[0]) setDraft({ ...draft, coverAssetId: ids[0], coverUrl: `/api/content-reactions/media?key=${encodeURIComponent(`asset:${ids[0]}`)}&variant=thumbnail` }); setPicker(false); }} />
  </>;
}
