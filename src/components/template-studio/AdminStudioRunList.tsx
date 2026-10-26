'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, ChevronDown, ChevronRight, Film, RefreshCw } from 'lucide-react';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import type {
  StudioAdminRunDto,
  StudioAdminRunListResponse,
  StudioRunStatus,
} from '@/lib/template-studio/types';
import styles from './admin-studio-runs.module.css';

type StatusFilter = 'exceptions' | 'all' | StudioRunStatus;
type CursorBucket = { nextCursor: string | null };
type StatusKey = StudioRunStatus | 'all';

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'exceptions', label: '异常记录' },
  { value: 'all', label: '全部状态' },
  { value: 'uncertain', label: '结果待核对' },
  { value: 'failed', label: '执行失败' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '处理中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
];

function statusName(status: string) {
  const names: Record<string, string> = {
    queued: '排队中', running: '处理中', succeeded: '已完成', failed: '执行失败',
    uncertain: '结果待核对', cancelled: '已取消',
  };
  return names[status] || '状态待识别';
}

function sourceName(source: string) {
  return source === 'legacy' ? '旧模板' : source === 'studio' ? '工作台模板' : '空白模块';
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

async function readRunPage(status: StatusKey, cursor?: string): Promise<StudioAdminRunListResponse> {
  const params = new URLSearchParams();
  if (status !== 'all') params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  const response = await fetch(`/api/admin/template-studio/runs?${params.toString()}`, { cache: 'no-store' });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error : '异常记录暂时无法读取。';
    throw new Error(error);
  }
  if (!payload || typeof payload !== 'object' || !('items' in payload) || !Array.isArray(payload.items)) {
    throw new Error('服务返回的记录格式无法识别。');
  }
  return payload as StudioAdminRunListResponse;
}

function mergeRuns(groups: StudioAdminRunDto[][]) {
  const unique = new Map<string, StudioAdminRunDto>();
  groups.flat().forEach((run) => unique.set(run.id, run));
  return Array.from(unique.values()).sort((left, right) => {
    const dateOrder = right.createdAt.localeCompare(left.createdAt);
    return dateOrder || right.id.localeCompare(left.id);
  });
}

function thumbnailFor(run: StudioAdminRunDto) {
  return run.tasks.find((task) => task.thumbnailUrl)?.thumbnailUrl || null;
}

export default function AdminStudioRunList() {
  const [filter, setFilter] = useState<StatusFilter>('exceptions');
  const [runs, setRuns] = useState<StudioAdminRunDto[]>([]);
  const [cursors, setCursors] = useState<Partial<Record<StatusKey, CursorBucket>>>({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestGeneration = useRef(0);
  const [reloadKey, setReloadKey] = useState(0);

  const selectedStatuses = useMemo<StatusKey[]>(() => {
    if (filter === 'exceptions') return ['uncertain', 'failed'];
    if (filter === 'all') return ['all'];
    return [filter];
  }, [filter]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setRuns([]);
    setCursors({});
    setNotice('');
    setError('');
    setLoading(true);
    setLoadingMore(false);

    void Promise.all(selectedStatuses.map(async (status) => ({ status, response: await readRunPage(status) })))
      .then((pages) => {
        if (generation !== requestGeneration.current) return;
        setRuns(mergeRuns(pages.map(({ response }) => response.items)));
        setCursors(Object.fromEntries(pages.map(({ status, response }) => [status, { nextCursor: response.nextCursor }])));
        setNotice(pages[0]?.response.reviewNotice || '');
      })
      .catch((reason: unknown) => {
        if (generation !== requestGeneration.current) return;
        setError(reason instanceof Error ? reason.message : '异常记录暂时无法读取。');
      })
      .finally(() => {
        if (generation === requestGeneration.current) setLoading(false);
      });

    return () => {
      if (generation === requestGeneration.current) requestGeneration.current += 1;
    };
  }, [selectedStatuses, reloadKey]);

  async function loadMore() {
    const generation = requestGeneration.current;
    const pending = selectedStatuses.flatMap((status) => {
      const cursor = cursors[status]?.nextCursor;
      return cursor ? [{ status, cursor }] : [];
    });
    if (pending.length === 0 || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const pages = await Promise.all(pending.map(async ({ status, cursor }) => ({
        status,
        response: await readRunPage(status, cursor),
      })));
      if (generation !== requestGeneration.current) return;
      setRuns((current) => mergeRuns([current, ...pages.map(({ response }) => response.items)]));
      setCursors((current) => ({
        ...current,
        ...Object.fromEntries(pages.map(({ status, response }) => [status, { nextCursor: response.nextCursor }])),
      }));
      if (pages[0]?.response.reviewNotice) setNotice(pages[0].response.reviewNotice);
    } catch (reason) {
      if (generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : '下一页暂时无法读取。');
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false);
    }
  }

  const hasMore = selectedStatuses.some((status) => Boolean(cursors[status]?.nextCursor));

  return (
    <section className={styles.listSection} aria-label="模板提示词异常记录">
      <div className={styles.toolbar}>
        <label className={styles.filterLabel}>
          <span>状态</span>
          <span className={styles.selectWrap}>
            <select value={filter} onChange={(event) => setFilter(event.target.value as StatusFilter)}>
              {FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </label>
        <span className={styles.resultCount}>{loading ? '正在读取' : `${runs.length} 条记录`}</span>
      </div>

      {notice && <p className={styles.reviewNotice}><AlertTriangle size={16} aria-hidden="true" />{notice}</p>}
      {error && <div className={styles.errorNotice} role="alert"><span>{error}</span><button type="button" onClick={() => setReloadKey((value) => value + 1)} aria-label="重新读取"><RefreshCw size={16} /></button></div>}

      <div className={styles.runList}>
        <div className={`${styles.runRow} ${styles.runHeader}`} aria-hidden="true">
          <span>视频</span><span>用户与运行</span><span>状态</span><span>创建时间</span><span>关联视频</span><span />
        </div>
        {runs.map((run) => {
          const thumbnail = thumbnailFor(run);
          return (
            <article className={styles.runRow} key={run.id} data-run-id={run.id}>
              <span className={styles.thumbnailCell}>
                {thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumbnail} alt="关联视频截图" loading="lazy" />
                ) : <span className={styles.thumbnailFallback}><Film size={20} /><small>暂无截图</small></span>}
              </span>
              <span className={styles.runIdentity}>
                <UserIdentityBadge
                  size="sm"
                  user={{ id: run.owner.id, name: run.owner.displayName, avatar_url: run.owner.avatarUrl }}
                />
                <strong>{run.templateName || sourceName(run.source)}</strong>
                <small>{run.mode === 'llm' ? 'AI 整理' : '直接套用'} · {run.model || '未记录模型'}</small>
                <code>{run.id}</code>
              </span>
              <span className={styles.statusCell}>
                <em className={`${styles.status} ${run.status === 'uncertain' ? styles.statusUnknown : run.status === 'failed' ? styles.statusFailed : ''}`}>
                  {statusName(run.status)}
                </em>
                <small>提交状态：{run.deliveryState === 'unknown' ? '待核对' : run.deliveryState === 'not_sent' ? '未提交' : run.deliveryState === 'sending' ? '提交中' : '已收到响应'}</small>
              </span>
              <time dateTime={run.createdAt}>{formatDate(run.createdAt)}</time>
              <span className={styles.taskCount}>{run.taskCount} 条</span>
              <Link className={styles.detailLink} href={`/admin/agent-runs/template-prompts/${encodeURIComponent(run.id)}`} aria-label={`查看详情 ${run.id}`}>
                查看详情 <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </article>
          );
        })}
        {!loading && runs.length === 0 && !error && <p className={styles.emptyState}>当前筛选下没有运行记录。</p>}
        {loading && <p className={styles.emptyState}>正在读取运行记录…</p>}
      </div>

      {hasMore && <button className={styles.loadMore} type="button" onClick={loadMore} disabled={loadingMore}>
        {loadingMore ? '正在读取…' : '加载更多'} <ChevronRight size={16} aria-hidden="true" />
      </button>}
      <Link className={styles.backLink} href="/admin/agent-runs">返回旧执行链路</Link>
    </section>
  );
}
