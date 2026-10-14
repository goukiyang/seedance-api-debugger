'use client';

import { useId, type ReactNode, type RefObject } from 'react';
import { MoreHorizontal, RefreshCw, Search, X } from 'lucide-react';
import { RelativeTime } from '@/components/RelativeTime';
import styles from './ModuleGallery.module.css';

export type ModuleGalleryItem = {
  key: string;
  id: string;
  name: string;
  groupName: string;
  shared: boolean;
  mine: boolean;
  lastOpenedAt?: number | null;
  visual: ReactNode;
  loading?: boolean;
  error?: boolean;
  unread?: boolean;
  canEditCover?: boolean;
  onOpen: () => void;
  onEditCover?: () => void;
};

export type ModuleGalleryProps = {
  items: ModuleGalleryItem[];
  total: number | null;
  filteredTotal: number | null;
  query: string;
  onQueryChange: (value: string) => void;
  scope: 'all' | 'mine' | 'shared';
  onScopeChange: (value: ModuleGalleryProps['scope']) => void;
  sort: 'recent' | 'directory';
  onSortChange: (value: ModuleGalleryProps['sort']) => void;
  onReset: () => void;
  gridRef: RefObject<HTMLDivElement>;
  pagination: ReactNode;
  headerActions: ReactNode;
  title: string;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  opening?: boolean;
};

const scopes = [
  { value: 'all', label: '全部' },
  { value: 'mine', label: '我的' },
  { value: 'shared', label: '共享' },
] as const;

export function ModuleGallery({ items, total, filteredTotal, query, onQueryChange, scope, onScopeChange,
  sort, onSortChange, onReset, gridRef, pagination, headerActions, title, loading = false,
  error = false, onRetry, opening = false }: ModuleGalleryProps) {
  const headingId = useId();
  const hasFilter = Boolean(query.trim()) || scope !== 'all';
  return <section className={styles.gallery} aria-labelledby={headingId}>
    <header className={styles.header}>
      <div className={styles.heading}>
        <h1 id={headingId}>{title}</h1>
        <span className={styles.count} aria-live="polite">
          {total === null ? '数量待读取' : hasFilter
            ? filteredTotal === null ? `共 ${total} 个模块，筛选数量待读取` : `${filteredTotal} / ${total} 个模块`
            : `${total} 个模块`}
        </span>
      </div>
      <div className={styles.headerActions}>{headerActions}</div>
    </header>
    <div className={styles.toolbar}>
      <label className={styles.search}>
        <Search size={17} aria-hidden="true" />
        <span className={styles.srOnly}>搜索模块名称或分组</span>
        <input type="search" value={query} placeholder="搜索模块名称、分组" onChange={event => onQueryChange(event.target.value)} />
        {query && <button type="button" className={styles.clearSearch} aria-label="清空搜索" onClick={() => onQueryChange('')}><X size={16} aria-hidden="true" /></button>}
      </label>
      <div className={styles.scopes} role="group" aria-label="模块范围">
        {scopes.map(option => <button key={option.value} type="button" className={styles.scope}
          aria-pressed={scope === option.value} onClick={() => onScopeChange(option.value)}>{option.label}</button>)}
      </div>
      <label className={styles.sort}>
        <span className={styles.srOnly}>模块排序</span>
        <select value={sort} onChange={event => onSortChange(event.target.value as ModuleGalleryProps['sort'])}>
          <option value="recent">最近使用（本机）</option>
          <option value="directory">原目录顺序</option>
        </select>
      </label>
      <button type="button" className={styles.reset} onClick={onReset}>重置</button>
    </div>
    {error && <div className={styles.notice} role="alert">
      <span>模块未能完整读取，已有内容仍可查看。</span>
      {onRetry && <button type="button" className={styles.retry} disabled={loading} onClick={onRetry}><RefreshCw size={15} aria-hidden="true" />重试读取</button>}
    </div>}
    {opening && <p className={styles.status} role="status">正在打开模块…</p>}
    {loading && <p className={styles.status} role="status">正在读取模块…</p>}
    <div ref={gridRef} className={styles.grid} aria-busy={loading}>
      {items.map(item => {
        const timestamp = item.lastOpenedAt;
        const validTime = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
          && timestamp <= 8_640_000_000_000_000;
        const editable = item.canEditCover === true && Boolean(item.onEditCover);
        return <article key={item.key} className={styles.card} data-module-id={item.id} data-remember-scroll-anchor={`module-cover:${item.key}`}
          data-shared={item.shared} data-mine={item.mine} data-loading={Boolean(item.loading)} data-error={Boolean(item.error)}>
          <div className={styles.visual}>
            {item.loading || item.error ? <div className={styles.placeholder}>
              <span role={item.error ? 'alert' : 'status'}>{item.error ? '封面未能读取' : '读取封面中…'}</span>
            </div> : item.visual}
          </div>
          <button type="button" className={styles.openCard} disabled={opening || item.loading}
            aria-label={`打开模块：${item.name}`} onClick={item.onOpen} />
          <div className={styles.footer}>
            <div className={styles.titleRow}>
              <h3 title={item.name}>{item.name}</h3>
              {item.unread && <span className={styles.unread} role="img" aria-label="有未读结果" />}
            </div>
            <div className={styles.metadata}>
              <span className={styles.group} title={item.groupName || '未分组'}>{item.groupName || '未分组'}</span>
              <span className={styles.lastUsed}>
                {validTime ? <><RelativeTime value={new Date(timestamp).toISOString()} className={styles.time} /><span>使用</span></>
                  : <span>无本机记录</span>}
              </span>
            </div>
            <div className={styles.cardActions}>
              {item.error && onRetry && <button type="button" className={styles.cardAction} disabled={loading}
                aria-label={`重试读取封面：${item.name}`} title="重试读取封面" onClick={onRetry}><RefreshCw size={17} aria-hidden="true" /></button>}
              {editable && <button type="button" className={styles.cardAction} disabled={opening}
                aria-label={`设置封面：${item.name}`} title="设置封面" onClick={item.onEditCover}><MoreHorizontal size={20} aria-hidden="true" /></button>}
            </div>
          </div>
        </article>;
      })}
    </div>
    {!items.length && !loading && !error && <div className={styles.empty} role="status">
      <p>{hasFilter ? '没有找到匹配的模块' : '暂无可查看的模块'}</p>
      {query && <button type="button" className={styles.retry} onClick={() => onQueryChange('')}>清空搜索</button>}
      {!query && scope !== 'all' && <button type="button" className={styles.retry} onClick={() => onScopeChange('all')}>查看全部模块</button>}
    </div>}
    <div className={styles.pagination}>{pagination}</div>
  </section>;
}
