'use client';
import { useEffect, useRef, useState } from 'react';
import { readJsonResponse } from '@/lib/http/json-response';
import { useAppSession } from '@/lib/context/AppSessionContext';
import type { StudioTemplateAuthor } from '@/lib/image-studio/shared-types';
import { RelativeTime } from './RelativeTime';
import { TemplateDefinitionRead } from './TemplateDefinitionRead';
import styles from './TemplateRead.module.css';
type Item = { presetId: string; name: string; author: StudioTemplateAuthor; lifecycle: 'active' | 'archived'; isShared: boolean; sourceRevision: string; updatedAt: string; definitionAvailable: boolean };
type Directory = { items: Item[]; nextCursor: string | null; hasMore: boolean; error?: string };
export function TemplateDefinitionDirectory({ ownerId }: { ownerId: string }) {
  const { user, sessionChanged } = useAppSession();
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [items, setItems] = useState<Item[]>([]), [cursor, setCursor] = useState<string | null>(null), [hasMore, setHasMore] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [target, setTarget] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const sequence = useRef(0), reading = useRef(false);
  const allowed = user?.id === ownerId && user.role === 'admin' && user.account_type === 'internal' && !sessionChanged;
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setTarget(null); }, [ownerId, sessionChanged]);
  async function load(after?: string | null) {
    if (!allowed || reading.current) return;
    reading.current = true; setBusy(true); setError(''); const token = sequence.current;
    try {
      const params = new URLSearchParams({ mode: 'admin-directory', limit: '24', q: search }); if (after) params.set('cursor', after);
      const response = await fetch(`/api/image-studio/presets?${params}`, { cache: 'no-store' });
      const data = await readJsonResponse<Directory>(response);
      if (token !== sequence.current) return;
      if (!response.ok) throw new Error(data.error || '模板目录暂不可读');
      setItems(current => after ? [...current, ...data.items.filter(item => !current.some(old => old.presetId === item.presetId))] : data.items);
      setCursor(data.nextCursor); setHasMore(data.hasMore);
    } catch (cause) { if (token === sequence.current) setError(cause instanceof Error ? cause.message : '模板目录暂不可读'); }
    finally { if (token === sequence.current) { reading.current = false; setBusy(false); } }
  }
  useEffect(() => {
    sequence.current++; reading.current = false; setItems([]); setCursor(null); setHasMore(false); setTarget(null);
    if (allowed) void load();
    return () => { sequence.current++; };
  }, [allowed, search, retry]);
  if (!allowed) return null;
  return <section className={styles.directory} aria-label="全部模板定义"><p>包含未共享与已归档模板</p><label>搜索模板<input type="search" value={query} maxLength={80} onChange={event => setQuery(event.target.value)} /></label>
    {items.map(item => <article key={item.presetId}><div><strong>{item.name}</strong><span>{item.author.state === 'known' ? item.author.isSelf ? '我' : item.author.displayName || '模板作者' : '来源无法确认'} · {item.lifecycle === 'archived' ? '已归档' : item.isShared ? '已共享' : '未共享'}</span><small><RelativeTime value={item.updatedAt} /></small></div><button type="button" disabled={!item.definitionAvailable} onClick={() => setTarget(item.presetId)}>查看上下文</button></article>)}
    {busy && <p role="status">正在读取模板</p>}{error && <p role="status">{error}<button type="button" onClick={() => void load(cursor)}>重新读取</button></p>}
    {!busy && !error && !items.length && <p>没有符合条件的模板</p>}
    <div><button type="button" disabled={busy} onClick={() => setRetry(value => value + 1)}>刷新目录</button>{hasMore && <button type="button" disabled={busy} onClick={() => void load(cursor)}>加载更多</button>}</div>
    {target && <TemplateDefinitionRead key={`${ownerId}:${target}`} target={{ presetId: target }} scopeKey={`${ownerId}:admin-definition:${target}`} onClose={() => setTarget(null)} />}
  </section>;
}
