'use client';
import { ProjectSelector } from '@/components/ProjectSelector';
import { useProjectCatalogRevision } from '@/lib/projects/selector-client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { isResolvedCreationIntent, useCreationContext } from '@/lib/hooks/use-creation-context';
import CreationAvailability from './CreationAvailability';
export default function DraftUpgradeAction({ task, ownerId, enabled = true, onAccepted }: { task: { id: string; project_id?: string | null; video_card_id?: string | null; local_status: string }; ownerId?: string | null; enabled?: boolean; onAccepted?: (id: string) => void }) {
  const projectCatalogRevision = useProjectCatalogRevision();
  const [destination, setDestination] = useState(task.project_id || ''), [confirmed, setConfirmed] = useState(Boolean(task.project_id));
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]), [body, setBody] = useState<Record<string, unknown> | null>(null);
  const [cost, setCost] = useState<number | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [accepted, setAccepted] = useState('');
  const creation = useCreationContext({ ownerId, entry: 'draft_upgrade', draftId: task.id, projectId: destination, legacyCardId: task.video_card_id, enabled: false, onProjectChange: setDestination });
  useEffect(() => { if (task.project_id) return; let active = true; void fetch('/api/projects?lite=true', { cache: 'no-store' }).then(response => response.json()).then(data => { if (active) setProjects(data.projects || []); }).catch(() => undefined); return () => { active = false; }; }, [task.project_id, projectCatalogRevision]);
  const pendingKey = `sd2-draft-upgrade-request-v1:${ownerId}:${task.id}`, requestId = `draft-upgrade:${task.id}`;
  const prepare = async (baseline?: string) => {
    if (!destination || !confirmed || !ownerId) { setMessage('请先确认本次结果的保存项目'); return; }
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/tasks/${task.id}/draft-upgrade?project_id=${encodeURIComponent(destination)}`, { cache: 'no-store' });
      const quote = await response.json(); if (!response.ok) throw new Error(quote.message || quote.error || '升级资格暂时无法确认');
      if (!creation.isCurrent()) return;
      if (quote.accepted?.id) { sessionStorage.removeItem(pendingKey); setAccepted(quote.accepted.id); onAccepted?.(quote.accepted.id); return; }
      if (sessionStorage.getItem(pendingKey)) throw new Error('原升级提交仍待确认，只查询原请求，不会再次发送');
      const input = { ...quote.creation_input, baseline_task_id: baseline || creation.intent?.spec?.baseline_task_id || task.id,
        creation_contract_version: 2, resolution_approval_confirmed: true, pricing_revision: quote.pricing_revision, idempotency_key: requestId };
      const intent = await creation.prepare(input, requestId, creation.intent);
      if (isResolvedCreationIntent(intent)) { setMessage('原升级请求已有处理结果，请核对下方原任务。'); return; }
      setBody(input); setCost(intent.quote?.estimated_cost ?? quote.estimatedCost);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '暂时无法确认'); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!body || !creation.intent?.availability?.canSubmit || busy) return;
    setBusy(true); setMessage('');
    try {
      // Refreshing a token never changes the original operation identity.
      const intent = await creation.prepare(body, requestId, creation.intent);
      if (isResolvedCreationIntent(intent) || !intent.availability?.canSubmit) return;
      sessionStorage.setItem(pendingKey, 'pending');
      const response = await fetch(`/api/tasks/${task.id}/draft-upgrade`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': ownerId || '' },
        body: JSON.stringify({ ...body, intent_id: intent.id, intent_revision: intent.revision,
          resolution_approval_id: intent.approval_id, pricing_quote_token: intent.quote?.pricing_quote_token,
          pricing_revision: intent.quote?.pricing_revision || body.pricing_revision, max_estimated_cost: cost }) });
      const data = await response.json();
      if (!creation.isCurrent()) return;
      if (!response.ok || !(data.id || data.task_id)) throw new Error(data.message || data.error || '升级受理待确认，请查询原请求');
      const id = data.id || data.task_id; await creation.acceptTask(requestId, id); sessionStorage.removeItem(pendingKey); setAccepted(id); onAccepted?.(id);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '升级受理待确认'); }
    finally { setBusy(false); }
  };
  return <details><summary>沿用样片生成1080p</summary>
    {!task.project_id && <label>保存到<ProjectSelector  className="input" value={confirmed ? destination : ''} onChange={event => { setDestination(event.target.value); setConfirmed(Boolean(event.target.value)); setBody(null); }}><option value="">选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</ProjectSelector></label>}
    {message && <p role="status">{message}</p>}
    {accepted ? <Link href={`/tasks/${accepted}`}>查看原升级任务 {accepted}</Link> : <>
      <button type="button" className="btn btn-secondary" disabled={busy || !enabled || task.local_status !== 'succeeded'} onClick={() => void prepare()}>{busy ? '正在核对' : body ? '重新核对原升级请求' : '准备1080p升级'}</button>
      <CreationAvailability controller={creation} onBaselineChange={id => void prepare(id)} />
      {body && creation.intent?.availability?.canSubmit && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>生成1080p · {cost === null ? '报价待确认' : `${cost}点`}</button>}
    </>}
  </details>;
}
