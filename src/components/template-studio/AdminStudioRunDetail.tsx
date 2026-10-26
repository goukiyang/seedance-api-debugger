'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Film, RefreshCw } from 'lucide-react';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import type { StudioAdminRunDetailResponse, StudioAdminRunDto } from '@/lib/template-studio/types';
import styles from './admin-studio-runs.module.css';

function statusName(status: string) {
  const names: Record<string, string> = {
    queued: '排队中', running: '处理中', succeeded: '已完成', failed: '执行失败',
    uncertain: '结果待核对', cancelled: '已取消',
  };
  return names[status] || '状态待识别';
}

function formatDate(value: string | null) {
  if (!value) return '尚未完成';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function deliveryName(value: StudioAdminRunDto['deliveryState']) {
  const names: Record<StudioAdminRunDto['deliveryState'], string> = {
    not_sent: '尚未提交上游', sending: '正在提交', response_received: '已收到响应', unknown: '结果待核对',
  };
  return names[value];
}

function VideoTaskList({ run }: { run: StudioAdminRunDto }) {
  if (run.tasks.length === 0) return <p className={styles.emptyState}>没有关联的视频任务。</p>;
  return (
    <div className={styles.taskList}>
      <div className={`${styles.taskRow} ${styles.taskHeader}`} aria-hidden="true">
        <span>视频截图</span><span>任务状态</span><span>创建时间</span><span>播放/下载</span><span />
      </div>
      {run.tasks.map((task) => (
        <article className={styles.taskRow} key={task.id} data-admin-task-id={task.id}>
          <span className={styles.thumbnailCell}>
            {task.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={task.thumbnailUrl} alt="关联视频截图" loading="lazy" />
            ) : <span className={styles.thumbnailFallback}><Film size={20} /><small>暂无截图</small></span>}
          </span>
          <span><strong>{task.status}</strong>{task.deliveryStatus && <small>交付：{task.deliveryStatus}</small>}</span>
          <time dateTime={task.createdAt}>{formatDate(task.createdAt)}</time>
          <span className={styles.mediaLinks}>
            {task.playUrl ? <a href={task.playUrl}>播放</a> : <small>不可播放</small>}
            {task.downloadUrl ? <a href={task.downloadUrl}>下载</a> : <small>暂无下载</small>}
          </span>
          <Link className={styles.detailLink} href={task.href}>查看任务</Link>
        </article>
      ))}
      {run.tasksTruncated && <p className={styles.reviewNotice}>关联视频较多，本页仅展示部分任务。</p>}
    </div>
  );
}

export default function AdminStudioRunDetail({ runId }: { runId: string }) {
  const [result, setResult] = useState<StudioAdminRunDetailResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/admin/template-studio/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error : '运行详情暂时无法读取。';
        throw new Error(message);
      }
      if (!payload || typeof payload !== 'object' || !('run' in payload)) throw new Error('服务返回的详情格式无法识别。');
      setResult(payload as StudioAdminRunDetailResponse);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '运行详情暂时无法读取。');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => { void load(); }, [load]);

  const run = result?.run;
  const reviewNotice = result?.reviewNotice || '';
  const needsReview = run?.status === 'uncertain' || run?.deliveryState === 'unknown';

  return (
    <section className={styles.detailSection} aria-label="模板提示词运行详情">
      <div className={styles.detailToolbar}>
        <Link className={styles.backLink} href="/admin/agent-runs/template-prompts"><ArrowLeft size={16} /> 返回异常记录</Link>
        <button type="button" onClick={() => void load()} disabled={loading} aria-label="重新读取详情"><RefreshCw size={16} /> 重新读取</button>
      </div>
      {loading && !run && <p className={styles.emptyState}>正在读取运行详情…</p>}
      {error && <p className={styles.errorNotice} role="alert">{error}</p>}
      {run && <>
        <header className={styles.detailHead}>
          <div>
            <span className={styles.eyebrow}>模板提示词运行</span>
            <h2>{statusName(run.status)}</h2>
            <code>{run.id}</code>
          </div>
          <UserIdentityBadge size="md" user={{ id: run.owner.id, name: run.owner.displayName, avatar_url: run.owner.avatarUrl }} />
        </header>

        {needsReview && <div className={styles.manualReview} role="note">
          <AlertTriangle size={20} aria-hidden="true" />
          <div>
            <strong>本站结果待人工核对</strong>
            <p>{run.safeError || reviewNotice}</p>
            <p>请人工核对本站与服务商记录；此页面没有上游查询能力，也不会自动重试。</p>
          </div>
        </div>}
        {run.status === 'failed' && !needsReview && run.safeError && <p className={styles.reviewNotice}>{run.safeError}</p>}
        {!needsReview && <p className={styles.reviewNotice}>{reviewNotice}</p>}

        <dl className={styles.runFacts}>
          <div><dt>提交状态</dt><dd>{deliveryName(run.deliveryState)}</dd></div>
          <div><dt>运行方式</dt><dd>{run.mode === 'llm' ? 'AI 整理' : '直接套用'}</dd></div>
          <div><dt>来源</dt><dd>{run.source === 'blank' ? '空白模块' : run.source === 'legacy' ? '旧模板' : '工作台模板'}</dd></div>
          <div><dt>模板</dt><dd>{run.templateName || '未关联模板'}</dd></div>
          <div><dt>模型</dt><dd>{run.model || '未记录'}</dd></div>
          <div><dt>尝试次数</dt><dd>{run.attempt}</dd></div>
          <div><dt>创建时间</dt><dd>{formatDate(run.createdAt)}</dd></div>
          <div><dt>结束时间</dt><dd>{formatDate(run.completedAt)}</dd></div>
          <div><dt>本站关联视频</dt><dd>{run.taskCount} 条</dd></div>
        </dl>

        <section className={styles.tasksSection} aria-labelledby="admin-studio-tasks-heading">
          <div className={styles.sectionHeading}><h3 id="admin-studio-tasks-heading">关联视频</h3><span>{run.taskCount} 条</span></div>
          <VideoTaskList run={run} />
        </section>
      </>}
    </section>
  );
}
