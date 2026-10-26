'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import PageBanner from '@/components/PageBanner';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { RelativeTime } from '@/components/RelativeTime';
import PaginationControls from '@/components/PaginationControls';
import { imageBillingLabel, type ImageBillingView } from '@/lib/image-studio/billing-contract';
import type { StudioProviderErrorDiagnostics, StudioProviderErrorEvent, StudioProviderErrorReadResult } from '@/lib/image-studio/provider-error-diagnostics';
import workbenchStyles from '../integrations/workbench.module.css';
import diagnosticStyles from './ImageStudioDiagnostics.module.css';

type AuditTask = {
  id: string;
  ownerId: string;
  owner: { id: string; name: string | null; username: string; email: string; avatar_url: string | null } | null;
  model: string;
  status: string;
  prompt: string;
  unitCredits: number;
  providerCostUsd: number | null;
  createdAt: string;
  deletedAt: string | null;
  billing: ImageBillingView | null;
  costStatus: 'pending' | 'conflict' | 'confirmed' | 'unconnected';
  asset: { original_url: string; width: number | null; height: number | null } | null;
};

type DiagnosticsPayload = StudioProviderErrorReadResult & { taskId: string };
type ExpandedTaskState = { accountId: string; restored: boolean; taskId: string | null };
type DiagnosticsView = {
  accountId: string;
  taskId: string;
  loading: boolean;
  payload: DiagnosticsPayload | null;
  error: string;
};

const DIAGNOSTIC_PHASE_LABELS: Record<StudioProviderErrorEvent['phase'], string> = {
  initial_request: '首次请求', summary: '状态查询', result: '结果读取', download: '媒体下载', validation: '本站校验',
};
const IDENTITY_LABELS: Record<StudioProviderErrorEvent['identityEvidence'], string> = {
  verified: '原任务编号已核对', not_independently_verified: '编号未独立证实', conflict: '编号冲突', not_applicable: '不适用',
};
const BODY_READ_LABELS: Record<StudioProviderErrorEvent['bodyRead'], string> = {
  valid_json: '已读取安全 JSON', invalid_json: '响应不是有效 JSON', empty_body: '响应正文为空', oversize: '响应正文超过诊断上限',
  timeout: '诊断读取超时', read_error: '诊断读取失败', not_read: '未读取正文',
};

function safeExpandedTaskId(value: unknown) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : null;
}

function diagnosticsStorageKey(accountId: string) {
  return `sd2-admin-image-diagnostics-expanded-v1:${accountId}`;
}

function diagnosticsPayload(value: unknown, taskId: string): DiagnosticsPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<DiagnosticsPayload>;
  if (candidate.taskId !== taskId || !['recorded', 'not_collected', 'unavailable'].includes(String(candidate.state))) return null;
  if (candidate.state === 'recorded' && (!candidate.diagnostics || candidate.diagnostics.schema !== 'image.provider-error.v1')) return null;
  if (candidate.state !== 'recorded' && candidate.diagnostics !== null) return null;
  return candidate as DiagnosticsPayload;
}

function feeStatusLabel(task: AuditTask) {
  if (task.costStatus === 'confirmed') return '已有确认费用记录';
  if (task.costStatus === 'conflict') return '费用记录存在冲突，仍需核对';
  if (task.costStatus === 'pending') return '供应商费用仍待核对';
  return '供应商费用仍未知，确认尚未接入';
}

function primaryDiagnosticSummary(diagnostics: StudioProviderErrorDiagnostics) {
  const specific = diagnostics.events.find(event => event.identityEvidence === 'conflict'
    || event.providerReasonCode !== null || event.localCode !== null || event.providerStatus === 'failed');
  return specific?.summary || diagnostics.events[0]?.summary || '已记录安全诊断，但具体原因仍未知。';
}

function valueLabel(value: string | number | null) {
  return value === null || value === '' ? '未知' : String(value);
}

function safeDiagnosticsCopy(diagnostics: StudioProviderErrorDiagnostics): StudioProviderErrorDiagnostics {
  return {
    schema: diagnostics.schema,
    binding: {
      taskId: diagnostics.binding.taskId,
      ownerId: diagnostics.binding.ownerId,
      fingerprint: diagnostics.binding.fingerprint,
      channelId: diagnostics.binding.channelId,
      configRevision: diagnostics.binding.configRevision,
      localRequestId: diagnostics.binding.localRequestId,
      providerTaskId: diagnostics.binding.providerTaskId,
    },
    frozen: {
      model: diagnostics.frozen.model,
      resolution: diagnostics.frozen.resolution,
      requestedRatio: diagnostics.frozen.requestedRatio,
      resolvedRatio: diagnostics.frozen.resolvedRatio,
      expectedSize: diagnostics.frozen.expectedSize,
    },
    request: {
      dispatchObserved: diagnostics.request.dispatchObserved,
      endpointKind: diagnostics.request.endpointKind,
      protocol: diagnostics.request.protocol,
      model: diagnostics.request.model,
      sentModel: diagnostics.request.sentModel,
      quality: diagnostics.request.quality,
      size: diagnostics.request.size,
      ratio: diagnostics.request.ratio,
      n: diagnostics.request.n,
      referenceCount: diagnostics.request.referenceCount,
    },
    firstObservedAt: diagnostics.firstObservedAt,
    lastObservedAt: diagnostics.lastObservedAt,
    eventCount: diagnostics.eventCount,
    omittedEvents: diagnostics.omittedEvents,
    events: diagnostics.events.map(event => ({
      phase: event.phase,
      observedAt: event.observedAt,
      lastObservedAt: event.lastObservedAt,
      occurrences: event.occurrences,
      dispatchObserved: event.dispatchObserved,
      transportHttpStatus: event.transportHttpStatus,
      providerStatus: event.providerStatus,
      providerReasonCode: event.providerReasonCode,
      providerCauseConfirmed: event.providerCauseConfirmed,
      providerErrorStage: event.providerErrorStage,
      attempt: event.attempt,
      imageRetryCount: event.imageRetryCount,
      recoveryCount: event.recoveryCount,
      clientDropped: event.clientDropped,
      localCode: event.localCode,
      expectedSize: event.expectedSize,
      actualWidth: event.actualWidth,
      actualHeight: event.actualHeight,
      identityEvidence: event.identityEvidence,
      bodyRead: event.bodyRead,
      unknownFields: event.unknownFields.map(field => ({
        field: field.field,
        present: field.present,
        length: field.length,
        recognition: field.recognition,
        disposition: field.disposition,
      })),
      summarySource: event.summarySource,
      summary: event.summary,
    })),
  };
}

function DiagnosticFields({ entries }: { entries: Array<[string, string | number | null]> }) {
  return <dl className={diagnosticStyles.fields}>{entries.map(([label, value]) => <div key={label}>
    <dt>{label}</dt><dd>{valueLabel(value)}</dd>
  </div>)}</dl>;
}

function DiagnosticEvents({ diagnostics }: { diagnostics: StudioProviderErrorDiagnostics }) {
  return <ol className={diagnosticStyles.events}>{diagnostics.events.map((event, index) => <li className={diagnosticStyles.event} key={`${event.phase}:${event.observedAt}:${index}`}>
    <div className={diagnosticStyles.eventHead}>
      <strong>{DIAGNOSTIC_PHASE_LABELS[event.phase]}</strong>
      <span><RelativeTime value={event.observedAt} />{event.occurrences > 1 ? ` · ${event.occurrences} 次` : ''}</span>
    </div>
    <p>{event.summary}</p>
    <DiagnosticFields entries={[
      ['真实发送', event.dispatchObserved ? '已观察到' : '未观察到'],
      ['HTTP', event.transportHttpStatus],
      ['供应商状态', event.providerStatus],
      ['供应商原因码', event.providerReasonCode],
      ['原因由供应商确认', event.providerCauseConfirmed === null ? null : event.providerCauseConfirmed ? '是' : '否'],
      ['错误阶段', event.providerErrorStage],
      ['本站错误码', event.localCode],
      ['编号核对', IDENTITY_LABELS[event.identityEvidence]],
      ['正文读取', BODY_READ_LABELS[event.bodyRead]],
      ['供应商尝试次数', event.attempt],
      ['图片重试次数', event.imageRetryCount],
      ['恢复次数', event.recoveryCount],
      ['客户端已断开', event.clientDropped === null ? null : event.clientDropped ? '是' : '否'],
      ['期望尺寸', event.expectedSize],
      ['实际尺寸', event.actualWidth !== null && event.actualHeight !== null ? `${event.actualWidth} × ${event.actualHeight}` : null],
    ]} />
    {event.lastObservedAt !== event.observedAt && <p className={diagnosticStyles.muted}>最近再次观察：<RelativeTime value={event.lastObservedAt} /></p>}
    {event.unknownFields.length > 0 && <p className={diagnosticStyles.muted}>为保护隐私，未识别的
      {event.unknownFields.map(field => field.field === 'message' ? '消息' : field.field === 'type' ? '类型' : '代码').join('、')}已省略。</p>}
  </li>)}</ol>;
}

function DiagnosticsPanel({ task, view, copyStatus, onRetry, onCopy }: {
  task: AuditTask;
  view: DiagnosticsView | null;
  copyStatus: string;
  onRetry: () => void;
  onCopy: (diagnostics: StudioProviderErrorDiagnostics) => void;
}) {
  const scoped = view?.taskId === task.id ? view : null;
  const payload = scoped?.payload;
  const diagnostics = payload?.state === 'recorded' ? payload.diagnostics : null;
  return <div className={diagnosticStyles.panel}>
    <div className={diagnosticStyles.summaryGrid}>
      <div><span>已知原因</span><strong>{scoped?.loading && !diagnostics ? '正在读取安全诊断…'
        : scoped?.error && !diagnostics ? '本次详情读取未完成'
          : payload?.state === 'not_collected' ? '本站没有这条任务的诊断记录'
            : payload?.state === 'unavailable' ? '诊断存储暂时无法读取'
              : diagnostics ? primaryDiagnosticSummary(diagnostics) : '正在准备读取'}</strong></div>
      <div><span>供应商费用</span><strong>{feeStatusLabel(task)}</strong>
        <small>{task.billing ? imageBillingLabel(task.billing) : '站内结算未记录'}</small></div>
    </div>
    {scoped?.loading && <p role="status" className={diagnosticStyles.muted}>{diagnostics ? '正在更新，以下仍是上次读取的安全诊断。' : '只读取本站已保存记录，不会重新生成、查询供应商或改变费用。'}</p>}
    {scoped?.error && <div className={diagnosticStyles.localError} role="status"><p>{scoped.error} 列表、筛选和已有图片没有改变。</p>
      <button className="btn btn-secondary" type="button" onClick={onRetry}>重试读取</button></div>}
    {payload?.state === 'not_collected' && <p className={diagnosticStyles.muted}>旧任务或诊断启用前的任务可能没有记录；不能据此判断供应商当时是否给过具体原因。</p>}
    {payload?.state === 'unavailable' && <div className={diagnosticStyles.localError} role="status"><p>这是本站诊断存储的临时读取问题，列表、筛选和已有图片没有改变。</p>
      <button className="btn btn-secondary" type="button" onClick={onRetry}>重试读取</button></div>}
    {diagnostics && <>
      <div className={diagnosticStyles.observed}>
        <span>首次记录 <RelativeTime value={diagnostics.firstObservedAt} /></span>
        <span>最近记录 <RelativeTime value={diagnostics.lastObservedAt} /></span>
        <span>累计 {diagnostics.eventCount} 次{diagnostics.omittedEvents > 0 ? `，中间 ${diagnostics.omittedEvents} 次已按上限省略` : ''}</span>
      </div>
      <div className={diagnosticStyles.actions}>
        <button className="btn btn-secondary" type="button" onClick={() => onCopy(diagnostics)}>复制安全诊断</button>
        {copyStatus && <span role="status">{copyStatus}</span>}
      </div>
      <details className={diagnosticStyles.section}>
        <summary>参数对账</summary>
        {!diagnostics.request.dispatchObserved && <p className={diagnosticStyles.muted}>未观察到真实首次发送。这可能是原号 GET 恢复；发送型号、画质、尺寸、比例、数量和参考图数均按未知显示。</p>}
        <h4>任务冻结参数</h4>
        <DiagnosticFields entries={[
          ['逻辑型号', diagnostics.frozen.model],
          ['分辨率', diagnostics.frozen.resolution],
          ['请求比例', diagnostics.frozen.requestedRatio],
          ['解析比例', diagnostics.frozen.resolvedRatio],
          ['期望尺寸', diagnostics.frozen.expectedSize],
        ]} />
        <h4>实际观察到的请求</h4>
        <DiagnosticFields entries={[
          ['发送已观察', diagnostics.request.dispatchObserved ? '是' : '否'],
          ['端点类型', diagnostics.request.endpointKind],
          ['协议', diagnostics.request.protocol],
          ['逻辑型号', diagnostics.request.model],
          ['实际发送型号', diagnostics.request.sentModel],
          ['画质', diagnostics.request.quality],
          ['尺寸', diagnostics.request.size],
          ['比例', diagnostics.request.ratio],
          ['单次数量', diagnostics.request.n],
          ['参考图数', diagnostics.request.referenceCount],
        ]} />
      </details>
      <details className={diagnosticStyles.section}>
        <summary>准确编号</summary>
        <dl className={diagnosticStyles.ids}>
          <div><dt>原任务 ID</dt><dd><code>{diagnostics.binding.taskId}</code></dd></div>
          <div><dt>用户 ID</dt><dd><code>{diagnostics.binding.ownerId}</code></dd></div>
          <div><dt>本站请求 ID</dt><dd><code>{diagnostics.binding.localRequestId || '未知'}</code></dd></div>
          <div><dt>供应商任务 ID</dt><dd><code>{diagnostics.binding.providerTaskId || '未知'}</code></dd></div>
          <div><dt>通道 ID</dt><dd><code>{diagnostics.binding.channelId || '未知'}</code></dd></div>
          <div><dt>配置修订</dt><dd><code>{diagnostics.binding.configRevision || '未知'}</code></dd></div>
          <div><dt>绑定指纹</dt><dd><code>{diagnostics.binding.fingerprint}</code></dd></div>
        </dl>
      </details>
      <details className={diagnosticStyles.section}>
        <summary>安全观察记录（{diagnostics.events.length}）</summary>
        <DiagnosticEvents diagnostics={diagnostics} />
      </details>
    </>}
  </div>;
}

export default function AdminImageStudioClient({ accountId }: { accountId: string }) {
  const router = useRouter(), searchParams = useSearchParams();
  const query = searchParams.toString();
  const explicitTaskId = safeExpandedTaskId(searchParams.get('task_id'));
  const sequence = useRef(0);
  const diagnosticsSequence = useRef(0);
  const [restored, setRestored] = useState(false);
  const [tasks, setTasks] = useState<AuditTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pagination, setPagination] = useState<{ page: number; pageSize: number; total: number; totalPages: number } | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ExpandedTaskState>({ accountId, restored: false, taskId: null });
  const [diagnosticView, setDiagnosticView] = useState<DiagnosticsView | null>(null);
  const [copyMessage, setCopyMessage] = useState<{ accountId: string; taskId: string; text: string } | null>(null);

  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/admin/image-studio/tasks?${query}`, { cache: 'no-store' });
      const value = await response.json();
      if (seq !== sequence.current) return;
      if (!response.ok) throw new Error(value.error || '读取失败');
      const safe = new URLSearchParams(), params = new URLSearchParams(query);
      for (const key of ['status', 'cost_status', 'result_status', 'model', 'owner_user_id', 'ownerId', 'task_id', 'moduleId', 'date_from', 'date_to', 'page', 'page_size']) {
        const item = params.get(key); if (item && item.length <= 120) safe.set(key, item);
      }
      try { localStorage.setItem(`sd2-admin-image-audit-v1:${accountId}`, JSON.stringify(safe.toString())); } catch { /* Persist only successfully read filters. */ }
      setTasks(value.tasks); setPagination(value.pagination);
    } catch (cause) { if (seq === sequence.current) setError(cause instanceof Error ? cause.message : '图片任务读取失败'); }
    finally { if (seq === sequence.current) setLoading(false); }
  }, [accountId, query]);

  useEffect(() => {
    if (!window.location.search) {
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(`sd2-admin-image-audit-v1:${accountId}`) || 'null');
        if (typeof saved === 'string' && saved.length < 2000 && saved) router.replace(`/admin/image-studio?${saved}`, { scroll: false });
      } catch { /* Browsing remains available without storage. */ }
    }
    setRestored(true);
  }, [accountId, router]);
  useEffect(() => {
    diagnosticsSequence.current++;
    setDiagnosticView(null);
    setCopyMessage(null);
    let taskId = explicitTaskId;
    if (taskId) {
      try { localStorage.setItem(diagnosticsStorageKey(accountId), taskId); }
      catch { /* The explicit task remains authoritative without storage. */ }
    } else {
      try { taskId = safeExpandedTaskId(localStorage.getItem(diagnosticsStorageKey(accountId))); }
      catch { taskId = null; }
    }
    setExpanded({ accountId, restored: true, taskId });
  }, [accountId, explicitTaskId]);
  useEffect(() => {
    if (!restored) return;
    void load(); return () => { sequence.current++; };
  }, [accountId, load, query, restored]);

  const loadDiagnostics = useCallback(async (taskId: string) => {
    const seq = ++diagnosticsSequence.current;
    setCopyMessage(null);
    setDiagnosticView(current => current?.accountId === accountId && current.taskId === taskId
      ? { ...current, loading: true, error: '' }
      : { accountId, taskId, loading: true, payload: null, error: '' });
    try {
      const params = new URLSearchParams({ task_id: taskId, diagnostics: '1' });
      const response = await fetch(`/api/admin/image-studio/tasks?${params}`, { cache: 'no-store' });
      const value: unknown = await response.json().catch(() => null);
      if (seq !== diagnosticsSequence.current) return;
      if (!response.ok) throw new Error(response.status === 404 ? '原任务已不存在，无法读取错误详情。' : '错误详情读取失败，请重试。');
      const payload = diagnosticsPayload(value, taskId);
      if (!payload) throw new Error('错误详情格式无法识别，请重试。');
      setDiagnosticView({ accountId, taskId, loading: false, payload, error: '' });
    } catch (cause) {
      if (seq !== diagnosticsSequence.current) return;
      const message = cause instanceof Error ? cause.message : '错误详情读取失败，请重试。';
      setDiagnosticView(current => current?.accountId === accountId && current.taskId === taskId
        ? { ...current, loading: false, error: message }
        : { accountId, taskId, loading: false, payload: null, error: message });
    }
  }, [accountId]);

  const expandedTaskId = expanded.accountId === accountId && expanded.restored ? expanded.taskId : null;
  useEffect(() => {
    if (!expandedTaskId || !tasks.some(task => task.id === expandedTaskId && (task.status === 'failed' || task.status === 'uncertain'))) return;
    void loadDiagnostics(expandedTaskId);
    return () => { diagnosticsSequence.current++; };
  }, [expandedTaskId, loadDiagnostics, tasks]);

  function changeExpandedTask(taskId: string | null) {
    diagnosticsSequence.current++;
    setDiagnosticView(null);
    setCopyMessage(null);
    setExpanded({ accountId, restored: true, taskId });
    try {
      if (taskId) localStorage.setItem(diagnosticsStorageKey(accountId), taskId);
      else localStorage.removeItem(diagnosticsStorageKey(accountId));
    } catch { /* Expansion remains usable when local storage is unavailable. */ }
  }

  async function copyDiagnostics(taskId: string, diagnostics: StudioProviderErrorDiagnostics) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(JSON.stringify(safeDiagnosticsCopy(diagnostics), null, 2));
      setCopyMessage({ accountId, taskId, text: '已复制安全诊断' });
    } catch {
      setCopyMessage({ accountId, taskId, text: '复制失败，可选中下方编号手动复制' });
    }
  }
  function filter(key: string, value: string) {
    const params = new URLSearchParams(query); params.delete('cursor'); params.delete('page');
    if (key === 'owner_user_id') params.delete('ownerId');
    if (value) params.set(key, value); else params.delete(key);
    if (key === 'result_status' && value) params.set('status', 'succeeded');
    if (key === 'status' && value !== 'succeeded') params.delete('result_status');
    router.replace(`/admin/image-studio?${params}`, { scroll: false });
  }

  async function download(id: string) {
    setDownloading(id); setError('');
    try {
      const response = await fetch(`/api/admin/image-studio/download?id=${encodeURIComponent(id)}`);
      if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.error || '下载失败'); }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `image-studio-${id.slice(0, 10)}.png`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '下载失败，请重试'); }
    finally { setDownloading(null); }
  }

  return <div className={`admin-integrations-page ${workbenchStyles.surface}`}>
    <PageBanner eyebrow="管理后台" title="图片任务审计" description="查看所有用户的图片任务、归属、状态和生成结果；普通用户只能看到自己的任务和资产。" />
    {error && <div className="outputs-message" data-tone="error"><p>{error}</p><button className="btn btn-secondary" type="button" onClick={() => void load()}>重试</button></div>}
    <section className="card">
      <div className="outputs-workbench-head"><div><h2>任务列表</h2><p>管理员审计范围包含已隐藏结果，下载仍需通过管理员专用接口。</p></div><button className="btn btn-secondary" type="button" onClick={() => void load()}>刷新</button></div>
      <div className="outputs-filter-row" style={{ flexWrap: 'wrap', marginBottom: 16 }}>
        <select className="input" aria-label="图片执行状态" value={searchParams.get('status') || ''} onChange={event => filter('status', event.target.value)}>
          <option value="">全部执行状态</option><option value="queued">等待生成</option><option value="running">生成中</option><option value="succeeded">已生成</option><option value="failed">生成失败</option><option value="uncertain">结果未确认</option>
        </select>
        <select className="input" aria-label="图片费用状态" value={searchParams.get('cost_status') || ''} onChange={event => filter('cost_status', event.target.value)}>
          <option value="">全部费用状态</option><option value="pending">供应商费用待核</option><option value="conflict">费用冲突</option><option value="confirmed">已有确认费用记录</option><option value="unconnected">供应商费用未接入</option>
        </select>
        <select className="input" aria-label="图片结果文件" value={searchParams.get('result_status') || ''} onChange={event => filter('result_status', event.target.value)}>
          <option value="">全部结果文件</option><option value="not_ready">已生成，结果文件未就绪</option><option value="ready">结果文件已登记</option>
        </select>
        <input className="input" aria-label="用户编号" placeholder="用户 ID" value={searchParams.get('owner_user_id') || searchParams.get('ownerId') || ''} onChange={event => filter('owner_user_id', event.target.value)} />
        <input className="input" aria-label="原图片任务编号" placeholder="原任务 ID" maxLength={120} value={searchParams.get('task_id') || ''} onChange={event => filter('task_id', event.target.value)} />
        <select className="input" aria-label="每页图片任务数量" value={searchParams.get('page_size') || '30'} onChange={event => filter('page_size', event.target.value)}>{[20, 30, 50, 100].map(size => <option key={size} value={size}>每页 {size} 条</option>)}</select>
        <details style={{ flexBasis: '100%' }} open={Boolean(searchParams.get('model') || searchParams.get('moduleId') || searchParams.get('date_from') || searchParams.get('date_to'))}><summary>型号、模块与日期</summary>
          <div className="outputs-filter-row">
            <select className="input" aria-label="图片型号" value={searchParams.get('model') || ''} onChange={event => filter('model', event.target.value)}><option value="">全部型号</option>{IMAGE_STUDIO_MODELS.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model]}</option>)}</select>
            <input className="input" aria-label="图片模块编号" placeholder="模块 ID" value={searchParams.get('moduleId') || ''} onChange={event => filter('moduleId', event.target.value)} />
            <input className="input" type="date" aria-label="图片开始日期" value={searchParams.get('date_from') || ''} onChange={event => filter('date_from', event.target.value)} />
            <input className="input" type="date" aria-label="图片结束日期" value={searchParams.get('date_to') || ''} onChange={event => filter('date_to', event.target.value)} />
          </div>
        </details>
        <button className="btn btn-secondary" type="button" onClick={() => {
          try { localStorage.removeItem(`sd2-admin-image-audit-v1:${accountId}`); } catch {}
          changeExpandedTask(null);
          router.replace('/admin/image-studio?page=1', { scroll: false });
        }}>重置筛选</button>
      </div>
      {loading && <p role="status">{tasks.length ? '正在更新，以下仍是上次读取内容' : '正在读取…'}</p>}
      {!loading && !tasks.length && !error && <p>暂无图片任务。</p>}
      {tasks.length > 0 && <div style={{ overflowX: 'auto' }}><table className="table"><thead><tr><th>预览</th><th>时间</th><th>用户</th><th>模型</th><th>执行状态</th><th>费用状态</th><th>画面描述</th><th>结果</th><th /></tr></thead><tbody>{tasks.map(task => {
        const canReadDiagnostics = task.status === 'failed' || task.status === 'uncertain';
        const isExpanded = canReadDiagnostics && expandedTaskId === task.id;
        const scopedView = diagnosticView?.accountId === accountId && diagnosticView.taskId === task.id ? diagnosticView : null;
        return <Fragment key={task.id}>
          <tr>
            <td><div style={{ width: 96, height: 64, display: 'grid', placeItems: 'center' }}>{task.asset ?
              // eslint-disable-next-line @next/next/no-img-element
              <img src={task.asset.original_url} alt="生成图片" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span>暂无预览</span>}</div></td>
            <td><RelativeTime value={task.createdAt} /></td>
            <td><UserIdentityBadge user={task.owner || { id: task.ownerId }} size="sm" /></td>
            <td>{IMAGE_STUDIO_MODEL_LABELS[task.model as ImageStudioModel] || task.model}</td>
            <td>{({ queued: '等待生成', running: '生成中', succeeded: '已生成', failed: '生成失败', uncertain: '结果未确认' } as Record<string, string>)[task.status] || task.status}
              {task.deletedAt && <span className="text-gray"> · 用户已隐藏</span>}</td>
            <td>{({ pending: '供应商费用待核', conflict: '费用记录冲突', confirmed: '已有确认费用记录', unconnected: '供应商费用未接入' })[task.costStatus]}
              <div className="text-gray text-sm">{task.billing ? imageBillingLabel(task.billing) : '站内结算未记录'}</div></td>
            <td>{task.prompt || '参考图生成'}</td>
            <td>{task.asset ? <a href={task.asset.original_url} target="_blank" rel="noreferrer">查看图片</a> : '-'}</td>
            <td><div className={diagnosticStyles.rowActions}>
              {canReadDiagnostics && <button className="btn btn-secondary" type="button" aria-expanded={isExpanded}
                aria-controls={`image-diagnostics-${task.id}`} onClick={() => changeExpandedTask(isExpanded ? null : task.id)}>
                {isExpanded ? '收起详情' : '错误详情'}
              </button>}
              {task.asset && <button className="btn btn-secondary" type="button" disabled={downloading !== null} onClick={() => void download(task.id)}>{downloading === task.id ? '准备下载' : '下载'}</button>}
            </div></td>
          </tr>
          {isExpanded && <tr className={diagnosticStyles.detailRow}><td className={diagnosticStyles.detailCell} colSpan={9} id={`image-diagnostics-${task.id}`}>
            <DiagnosticsPanel task={task} view={scopedView} copyStatus={copyMessage?.accountId === accountId && copyMessage.taskId === task.id ? copyMessage.text : ''}
              onRetry={() => void loadDiagnostics(task.id)} onCopy={diagnostics => void copyDiagnostics(task.id, diagnostics)} />
          </td></tr>}
        </Fragment>;
      })}</tbody></table></div>}
      {pagination && <PaginationControls {...pagination} label="图片任务" onPageChange={page => { const params = new URLSearchParams(query); params.set('page', String(page)); params.delete('cursor'); router.replace(`/admin/image-studio?${params}`, { scroll: false }); }} />}
    </section>
  </div>;
}
