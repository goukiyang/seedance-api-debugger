'use client';

import { useId, type ReactNode, type RefObject } from 'react';
import { MoreHorizontal, RefreshCw, Search, UserRound, X } from 'lucide-react';
import type { GalleryAuthor, GalleryScope, GallerySort } from '@/lib/image-studio/gallery-types';
import styles from './ModuleGallery.module.css';

export type ModuleGalleryItem = {
  key: string;
  id: string;
  name: string;
  groupName: string;
  shared: boolean;
  /** Short label next to the name, e.g. 共享模板 for a shared copy. */
  badge?: string;
  mine: boolean;
  lastOpenedAt?: number | null;
  visual: ReactNode;
  loading?: boolean;
  error?: boolean;
  unread?: boolean;
  canEditCover?: boolean;
  author?: GalleryAuthor;
  reactions?: ReactNode;
  onOpen: () => void;
  onEditCover?: () => void;
};

export type ModuleGalleryProps = {
  items: ModuleGalleryItem[];
  total: number | null;
  filteredTotal: number | null;
  query: string;
  onQueryChange: (value: string) => void;
  scope: GalleryScope;
  onScopeChange: (value: ModuleGalleryProps['scope']) => void;
  sort: GallerySort;
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
  authorKey?: string | null;
  authorLabel?: string;
  onAuthorChange?: (key: string | null) => void;
};

const scopes = [
  { value: 'all', label: '全部' },
  { value: 'mine', label: '我的' },
  { value: 'shared', label: '共享' },
  { value: 'favorites', label: '我的收藏' },
] as const;

export function ModuleGallery({ items, total, filteredTotal, query, onQueryChange, scope, onScopeChange,
  sort, onSortChange, onReset, gridRef, pagination, headerActions, title, loading = false,
  error = false, onRetry, opening = false, authorKey, authorLabel, onAuthorChange }: ModuleGalleryProps) {
  const headingId = useId();
  const hasFilter = Boolean(query.trim() || authorKey) || scope !== 'all';
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
        <span className={styles.srOnly}>搜索模块、作者或分组</span>
        <input type="search" value={query} placeholder="搜索模块、作者、分组" onChange={event => onQueryChange(event.target.value)} />
        {query && <button type="button" className={styles.clearSearch} aria-label="清空搜索" onClick={() => onQueryChange('')}><X size={16} aria-hidden="true" /></button>}
      </label>
      <div className={styles.scopes} role="group" aria-label="模块范围">
        {scopes.map(option => <button key={option.value} type="button" className={styles.scope}
          aria-pressed={scope === option.value} onClick={() => onScopeChange(option.value)}>{option.label}</button>)}
      </div>
      <label className={styles.sort}>
        <span className={styles.srOnly}>模块排序</span>
        <select value={sort} onChange={event => onSortChange(event.target.value as ModuleGalleryProps['sort'])}>
          <option value="created">最新创建</option>
          <option value="updated">最近更新</option>
          <option value="likes">最多点赞</option>
          <option value="recent">最近使用</option>
          <option value="name">名称</option>
          <option value="directory">原目录顺序</option>
        </select>
      </label>
      <button type="button" className={styles.reset} onClick={onReset}>重置</button>
      {authorKey && <button type="button" className={styles.authorCondition} onClick={() => onAuthorChange?.(null)} title="清除作者条件">{authorLabel || '已选作者'}<X size={14} /></button>}
    </div>
    {error && <div className={styles.notice} role="alert">
      <span>模块未能完整读取，已有内容仍可查看。</span>
      {onRetry && <button type="button" className={styles.retry} disabled={loading} onClick={onRetry}><RefreshCw size={15} aria-hidden="true" />重试读取</button>}
    </div>}
    {opening && <p className={styles.status} role="status">正在打开模块…</p>}
    {loading && <p className={styles.status} role="status">正在读取模块…</p>}
    <div ref={gridRef} className={styles.grid} aria-busy={loading}>
      {items.map(item => {
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
          {item.reactions}
          <div className={styles.footer}>
            <div className={styles.titleRow}>
              <h3 title={item.name}>{item.name}</h3>
              {item.unread && <span className={styles.unread} role="img" aria-label="有未读结果" />}
            </div>
            <button type="button" className={styles.author} disabled={!item.author?.known || !item.author.key}
              title={item.author?.displayName || '作者未知'} aria-label={`筛选作者：${item.author?.displayName || '作者未知'}`}
              onClick={() => item.author?.known && onAuthorChange?.(item.author.key)}>
              {item.author?.avatarUrl ? <img src={item.author.avatarUrl} alt="" loading="lazy" /> : <UserRound size={17} aria-hidden="true" />}
              <span>{item.author?.displayName || '作者未知'}</span>
            </button>
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
