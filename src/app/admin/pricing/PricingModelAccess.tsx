'use client';
import { useCallback, useEffect, useState } from 'react';
import { parseModelAccessSettings, supplementaryModelEnabled, type ModelAccessSettings } from '@/lib/pricing/model-availability-contract';
import { broadcastModelAvailabilityUpdated } from '@/lib/pricing/use-model-availability';
import styles from './pricing.module.css';

type Choice = { kind: 'text' | 'cutout'; model: string; label: string };
type Pending = { requestId: string; revision: string; settings: ModelAccessSettings };
const endpoint = '/api/admin/pricing/models';

export default function PricingModelAccess({ actorId }: { actorId: string }) {
  const [settings, setSettings] = useState<ModelAccessSettings | null>(null), [choices, setChoices] = useState<Choice[]>([]);
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [changes, setChanges] = useState<ModelAccessSettings['models']>([]), [hydrated, setHydrated] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const storageKey = `sd2:pricing-model-access:${actorId}`;
  const headers = { 'Content-Type': 'application/json', 'x-app-session-user': actorId };
  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: 'no-store', headers: { 'x-app-session-user': actorId } });
    const value = await response.json();
    if (!response.ok) { if ([401, 403].includes(response.status)) setSettings(null); throw new Error(value.error || '模型开关读取失败'); }
    setSettings(parseModelAccessSettings(JSON.stringify(value.settings))); setChoices(value.choices);
  }, [actorId]);
  useEffect(() => {
    let active = true;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const value = JSON.parse(raw) as Pending;
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId) || typeof value.revision !== 'string') throw new Error('invalid original save');
        parseModelAccessSettings(JSON.stringify(value.settings)); setPending(value);
      }
      const draft = localStorage.getItem(`${storageKey}:draft`);
      if (draft) setChanges(parseModelAccessSettings(draft).models);
      setHydrated(true);
    } catch { setStorageBlocked(true); setMessage('原模型开关记录无法读取，请先核对原操作；未发起新保存'); }
    void load().catch(error => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, [load, storageKey]);
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(`${storageKey}:draft`, JSON.stringify({ version: 1, revision: 'draft', models: changes })); }
    catch { setStorageBlocked(true); setMessage('模型开关草稿无法保存，请保留当前页面'); }
  }, [changes, hydrated, storageKey]);
  const effective = settings && { ...settings, models: [...settings.models.filter(item =>
    !changes.some(change => change.kind === item.kind && change.model === item.model)), ...changes] };

  const save = async () => {
    if (!effective || busy || storageBlocked) return;
    setBusy(true); setMessage('');
    try {
      const intent = pending || { requestId: crypto.randomUUID(), revision: effective.revision, settings: effective };
      if (!pending) { localStorage.setItem(storageKey, JSON.stringify(intent)); setPending(intent); }
      const response = await fetch(pending ? `${endpoint}?requestId=${encodeURIComponent(intent.requestId)}` : endpoint,
        pending ? { cache: 'no-store', headers } : { method: 'POST', headers, body: JSON.stringify(intent) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '保存结果尚未确认，请核对原保存');
      if (value.operation?.state === 'succeeded' || value.operation?.state === 'rejected') {
        if (value.operation.state === 'succeeded') { setSettings(value.operation.settings); setChanges([]); broadcastModelAvailabilityUpdated(); }
        localStorage.removeItem(storageKey); setPending(null);
        setMessage(value.operation.state === 'succeeded' ? '模型开放设置已保存' : value.operation.error || '本次未保存，请重新读取后修改');
      } else setMessage('原保存结果尚未确认，请继续核对原保存');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存结果尚未确认，请核对原保存'); }
    finally { setBusy(false); }
  };
  return <section className={styles.standard} aria-label="文字与抠图模型开放">
    <h2>文字与抠图模型</h2><p>关闭后，各使用入口隐藏该模型；原费用合同和已受理任务保留。</p>
    {choices.map(choice => <div key={`${choice.kind}:${choice.model}`} className={styles.pricingName}>
      <button type="button" role="switch" aria-label={`开放${choice.label}`} className={styles.pricingSwitch}
        aria-checked={!!effective && supplementaryModelEnabled(effective, choice.kind, choice.model)} disabled={!effective || busy || !!pending || storageBlocked}
        onClick={() => {
          if (!effective || !settings) return;
          const enabled = !supplementaryModelEnabled(effective, choice.kind, choice.model);
          setChanges(current => [...current.filter(item => item.kind !== choice.kind || item.model !== choice.model),
            ...(enabled === supplementaryModelEnabled(settings, choice.kind, choice.model) ? [] : [{ kind: choice.kind, model: choice.model, enabled }])]);
        }} />
      <span>{choice.label}</span>
    </div>)}
    <button type="button" disabled={!effective || busy || storageBlocked || !pending && !changes.length} onClick={() => void save()}>{busy ? '处理中' : pending ? '核对原保存' : '保存模型开放设置'}</button>
    <button type="button" disabled={busy || !!pending} onClick={() => void load().catch(error => setMessage(error.message))}>重新读取</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
