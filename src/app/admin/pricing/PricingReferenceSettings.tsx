'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { REFERENCE_PRICING_KINDS, parseReferenceSettings, type ReferencePriceChoice, type ReferencePricingKind,
  type ReferencePricingOperation, type ReferencePricingRule, type ReferencePricingSettings, type ReferencePricingSnapshot } from '@/lib/pricing/reference-contract';
import { multiplyDecimal, normalizeDecimal, roundDecimal } from '@/lib/pricing/math';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import { useProductDialog } from '@/components/useProductDialog';
import styles from './pricing.module.css';

const endpoint = '/api/admin/pricing/reference';
const names: Record<ReferencePricingKind, string> = { image: '图片', video: '视频', enhance: '视频增强', h3: 'H3', text: '文字', cutout: '抠图' };
const units = { image: '张', second: '秒', call: '次' };

export function broadcastReferencePricingUpdated(revision: string): boolean {
  window.dispatchEvent(new Event('pricing-reference-updated'));
  try { localStorage.setItem('sd2-pricing-revision', `${revision}:${Date.now()}`); return true; }
  catch { return false; }
}

export default function PricingReferenceSettings({ actorId, policyRevision, onUnauthorized }: {
  actorId: string; policyRevision: string; onUnauthorized: () => void;
}) {
  const [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<ReferencePricingSnapshot | null>(null);
  const [draft, setDraft] = useState<ReferencePricingSettings | null>(null), [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [storageIssue, setStorageIssue] = useState(false);
  const [operationIssue, setOperationIssue] = useState(false);
  const [reading, setReading] = useState(false);
  const [mapping, setMapping] = useState({ kind: 'image' as ReferencePricingKind, model: '', ruleId: '' });
  const mounted = useRef(false), lock = useRef(false), initialized = useRef(false), draftRef = useRef(draft), pendingRef = useRef(pending);
  const readSequence = useRef(0), readingRef = useRef(false), snapshotRef = useRef(snapshot);
  const { confirm, productDialog } = useProductDialog();
  draftRef.current = draft; pendingRef.current = pending;
  snapshotRef.current = snapshot;
  const storageKey = `sd2:pricing-reference:v1:${actorId}`;
  const operationKey = `${storageKey}:operation`;
  const headers = { 'x-app-session-user': actorId };

  const readResponse = useCallback(async (response: Response) => {
    const data = await response.json();
    if (!mounted.current) throw new Error('页面已离开');
    if (response.status === 401 || response.status === 403 || data.code === 'pricing_actor_changed') {
      onUnauthorized(); throw new Error('当前账号不可继续操作');
    }
    if (!response.ok) throw new Error(data.error || '读取失败，请保留草稿');
    return data;
  }, [onUnauthorized]);
  const load = useCallback(async (rebase = false) => {
    const sequence = ++readSequence.current;
    readingRef.current = true; setReading(true);
    try {
      const response = await fetch(endpoint, { cache: 'no-store', headers: { 'x-app-session-user': actorId } });
      const data: ReferencePricingSnapshot = await readResponse(response);
      if (!mounted.current || sequence !== readSequence.current) return;
      parseReferenceSettings(data.settings);
      const clean = !draftRef.current || JSON.stringify(draftRef.current) === JSON.stringify(snapshotRef.current?.settings);
      if (clean || rebase) {
        const next = clean ? data.settings : { ...draftRef.current!, revision: data.settings.revision };
        draftRef.current = next; setDraft(next);
      }
      snapshotRef.current = data;
      setSnapshot(data);
    } catch (error) { if (mounted.current && sequence === readSequence.current) setMessage(error instanceof Error ? error.message : '读取失败，草稿已保留'); }
    finally { if (mounted.current && sequence === readSequence.current) { readingRef.current = false; setReading(false); } }
  }, [actorId, readResponse]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!open || initialized.current) return;
    initialized.current = true;
    try {
      const saved = localStorage.getItem(storageKey), original = localStorage.getItem(operationKey);
      if (original) {
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(original)) throw new Error('原保存编号无法读取，请保留浏览器记录并核对，未发起新保存');
        pendingRef.current = original; setPending(original);
      }
      if (saved) { const restored = parseReferenceSettings(saved); draftRef.current = restored; setDraft(restored); }
    } catch (error) { setOperationIssue(true); setStorageIssue(true); setMessage(error instanceof Error ? error.message : '本地草稿无法读取'); }
  }, [open, storageKey, operationKey, load]);
  useEffect(() => { if (open && initialized.current) void load(); }, [policyRevision, open, load]);
  useEffect(() => {
    if (!draft || !snapshot || !initialized.current || operationIssue) return;
    try {
      if (JSON.stringify(draft) === JSON.stringify(snapshot.settings)) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(draft));
    }
    catch { setStorageIssue(true); }
  }, [draft, snapshot, storageKey, operationIssue]);

  function update(kind: ReferencePricingKind, patch: Partial<ReferencePriceChoice>) {
    setDraft(current => current && ({ ...current, defaults: { ...current.defaults, [kind]: { ...current.defaults[kind], ...patch } } }));
    setMessage('');
  }
  function decimal(kind: ReferencePricingKind, field: 'amountCny' | 'defaultQuantity' | 'tokenInputCny' | 'tokenOutputCny', value: string) {
    if (!value && field !== 'defaultQuantity') { update(kind, { [field]: null }); return; }
    try {
      normalizeDecimal(value, { maxScale: 8, max: field === 'defaultQuantity' ? '10000000' : '1000000', allowZero: field !== 'defaultQuantity' });
      update(kind, { [field]: value });
    } catch { setMessage(field === 'defaultQuantity' ? '兜底数量须为大于 0 的数' : '参考价须为非负金额，最多 8 位小数'); }
  }
  function points(amount: string | null, rule?: ReferencePricingRule) {
    if (amount === null) return '未设置';
    if (normalizeDecimal(amount) === '0') return '0 点';
    const rate = rule ? rule.pointsPerCny : snapshot?.pointsPerCny;
    return rate ? `${roundDecimal(multiplyDecimal([amount, rate]), rule?.rounding === 'half_up_integer' ? 0 : 1, 'half_up')} 点` : '换算费率未设置';
  }
  async function applyOperation(operation: ReferencePricingOperation, id: string) {
    if (operation.requestId !== id || !['succeeded', 'rejected', 'unknown'].includes(operation.state)) throw new Error('原保存回执不匹配');
    if (operation.state === 'unknown') { setMessage('保存结果待确认，只查询原请求，不会重新提交'); return; }
    const saved = operation.state === 'succeeded' ? parseReferenceSettings(operation.settings) : null;
    let storageOk = true;
    try { if (localStorage.getItem(operationKey) === id) localStorage.removeItem(operationKey); }
    catch { storageOk = false; setStorageIssue(true); setOperationIssue(true); }
    pendingRef.current = null; setPending(null);
    if (operation.state === 'rejected') { setMessage(operation.error || '未保存，草稿已保留'); return; }
    draftRef.current = saved!; setDraft(saved!);
    setSnapshot(current => current && ({ ...current, settings: saved! }));
    storageOk = broadcastReferencePricingUpdated(saved!.revision) && storageOk;
    if (!storageOk) setStorageIssue(true);
    setMessage(storageOk ? '已保存，历史实扣和点数不变' : '服务端已保存；此浏览器的同步通知未完整写入');
    await load();
  }
  async function queryOperation(id: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const response = await fetch(`${endpoint}?requestId=${encodeURIComponent(id)}`, { cache: 'no-store', headers });
      const data = await readResponse(response);
      if (mounted.current) await applyOperation(data.operation, id);
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : '原保存暂时无法确认'); }
    finally { if (mounted.current) { lock.current = false; setBusy(false); } }
  }
  useEffect(() => {
    if (pending) void queryOperation(pending);
    // Query once when recovering an operation. A missing receipt never resubmits it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  async function save() {
    if (!draft || !snapshot || pendingRef.current || lock.current || readingRef.current || operationIssue) return;
    let settings: ReferencePricingSettings;
    try { settings = parseReferenceSettings(draft); }
    catch (error) { setMessage(error instanceof Error ? error.message : '设置无效，草稿已保留'); return; }
    const id = crypto.randomUUID();
    try {
      if (localStorage.getItem(operationKey)) throw new Error('已有原保存需要核对');
      localStorage.setItem(operationKey, id);
      if (localStorage.getItem(operationKey) !== id) throw new Error('原保存编号未可靠记录');
    } catch (error) { setStorageIssue(true); setOperationIssue(true); setMessage(error instanceof Error ? error.message : '无法记录原请求，本次未提交'); return; }
    lock.current = true; pendingRef.current = id; setPending(id); setBusy(true); setMessage('');
    try {
      const response = await fetch(endpoint, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: settings.revision, requestId: id, settings }) });
      const data = await readResponse(response);
      if (mounted.current) await applyOperation(data.operation, id);
    } catch (error) { if (mounted.current) setMessage(`${error instanceof Error ? error.message : '保存结果待确认'}；请核对原保存`); }
    finally { if (mounted.current) { lock.current = false; setBusy(false); } }
  }

  const dirty = Boolean(draft && snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.settings));
  useEffect(() => {
    if (!dirty || !storageIssue) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty, storageIssue]);
  useUnsavedNavigation(dirty && storageIssue, confirm, {
    unsaved: dirty && storageIssue ? ['无法恢复的历史参考标价草稿'] : [], busy: [], onBlocked: setMessage,
  });
  return <><details className={styles.referenceSettings} open={open} aria-busy={busy || reading} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>历史参考标价{pending ? ' · 保存待确认' : dirty ? ' · 未保存' : ''}</summary>
    {open && <div className={styles.referenceBody}>
      <div className={styles.referenceToolbar}><span className={styles.muted}>当前参考价，不改历史实扣{snapshot?.pointsPerCny ? ` · ${snapshot.pointsPerCny} 点/元` : ''}</span>
        <button type="button" disabled={busy || reading || !!pending} title="读取当前版本并保留草稿" onClick={() => void load(true)}><RefreshCw size={16} aria-hidden="true" />{reading ? '正在读取' : '读取当前版本'}</button>
        {pending && (!draft || !snapshot) && <button type="button" disabled={busy} onClick={() => void queryOperation(pending)}><RefreshCw size={16} aria-hidden="true" />核对原保存</button>}
      </div>
      {!draft || !snapshot ? <p role="status">{message || '正在读取历史参考标价'}</p> : <>
        <fieldset className={styles.referenceFields} aria-label="类型默认参考价" disabled={busy || !!pending}>
          {REFERENCE_PRICING_KINDS.map(kind => {
            const choice = draft.defaults[kind], rule = snapshot.rules.find(item => item.id === choice.ruleId);
            const amount = choice.ruleId ? rule?.baseCny ?? null : choice.amountCny;
            const available = snapshot.rules.filter(item => item.kind === kind);
            return <div className={styles.referenceRow} key={kind}>
              <strong>{names[kind]}</strong>
              {(available.length > 0 || choice.ruleId) && <label>默认档<select value={choice.ruleId || ''} aria-label={`${names[kind]}默认规则`} onChange={event => {
                const selected = snapshot.rules.find(item => item.id === event.target.value);
                update(kind, { ruleId: selected?.id ?? null, amountCny: null, ...(selected ? { unit: selected.unit } : {}) });
              }}><option value="">单独参考价</option>{choice.ruleId && !rule && <option value={choice.ruleId}>原引用已失效，请重新选择</option>}
                {available.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select></label>}
              <label>元/{units[choice.unit]}<input type="number" min="0" max="1000000" step="any" aria-label={`${names[kind]}单位参考价`} disabled={!!choice.ruleId}
                value={amount ?? ''} placeholder="未设置" onChange={event => decimal(kind, 'amountCny', event.target.value)} /></label>
              {kind === 'h3' && !choice.ruleId && <label>单位<select aria-label={`${names[kind]}参考价单位`} value={choice.unit} onChange={event => update(kind, { unit: event.target.value as 'call' | 'second', ...(event.target.value === 'call' ? { defaultQuantity: '1' } : {}) })}><option value="call">每次</option><option value="second">每秒</option></select></label>}
              {choice.unit === 'second' && <label>缺时长兜底/秒<input type="number" min="0.00000001" max="10000000" step="any" aria-label={`${names[kind]}缺时长兜底秒数`} value={choice.defaultQuantity} onChange={event => decimal(kind, 'defaultQuantity', event.target.value)} /></label>}
              <output className={styles.referencePoints}>{points(amount, rule)} / {units[choice.unit]}</output>
              {kind === 'h3' && <small className={styles.referenceFull}>{amount !== null && normalizeDecimal(amount) === '0' ? 'API 原合同免费，不含机器成本' : '不含机器成本'}</small>}
              {kind === 'text' && <div className={styles.referenceTokens}>{(['tokenInputCny', 'tokenOutputCny'] as const).map((field, index) => <label key={field}>{index === 0 ? '输入' : '输出'}元/百万 token
                <input type="number" min="0" max="1000000" step="any" aria-label={`${index === 0 ? '输入' : '输出'}每百万token人民币参考价`} value={choice[field] ?? ''} placeholder="未设置" onChange={event => decimal(kind, field, event.target.value)} />
                <span className={styles.muted}>{points(choice[field] ?? null)} / 百万 token</span></label>)}</div>}
            </div>;
          })}
        </fieldset>
        <details className={styles.referenceMappings}><summary>旧型号映射 · {draft.models.length}</summary>
          <div className={styles.referenceMappingList}>{draft.models.map(item => <div key={`${item.kind}:${item.model}`} className={styles.referenceMappingRow}>
            <span>{names[item.kind]} · {item.model}</span><select disabled={busy || !!pending} aria-label={`${item.model}对应当前规则`} value={item.ruleId} onChange={event => setDraft(current => current && ({ ...current, models: current.models.map(row => row === item ? { ...row, ruleId: event.target.value } : row) }))}>
              {!snapshot.rules.some(rule => rule.id === item.ruleId) && <option value={item.ruleId}>原规则已失效</option>}{snapshot.rules.filter(rule => rule.kind === item.kind).map(rule => <option key={rule.id} value={rule.id}>{rule.label}</option>)}
            </select><button type="button" disabled={busy || !!pending} aria-label={`移除${item.model}映射`} title="移除映射" onClick={() => setDraft(current => current && ({ ...current, models: current.models.filter(row => row !== item) }))}><Trash2 size={16} aria-hidden="true" /></button>
          </div>)}</div>
          <div className={styles.referenceMappingRow}>
            <select aria-label="新映射类型" disabled={busy || !!pending} value={mapping.kind} onChange={event => setMapping(current => ({ ...current, kind: event.target.value as ReferencePricingKind, ruleId: '' }))}>{REFERENCE_PRICING_KINDS.map(kind => <option key={kind} value={kind}>{names[kind]}</option>)}</select>
            <input aria-label="旧型号标识" placeholder="旧型号标识" maxLength={500} value={mapping.model} disabled={busy || !!pending} onChange={event => setMapping(current => ({ ...current, model: event.target.value }))} />
            <select aria-label="新映射当前规则" disabled={busy || !!pending} value={mapping.ruleId} onChange={event => setMapping(current => ({ ...current, ruleId: event.target.value }))}><option value="">选择当前规则</option>{snapshot.rules.filter(rule => rule.kind === mapping.kind).map(rule => <option key={rule.id} value={rule.id}>{rule.label}</option>)}</select>
            <button type="button" title="添加映射" aria-label="添加旧型号映射" disabled={busy || !!pending || !mapping.model.trim() || !mapping.ruleId} onClick={() => {
              if (draft.models.some(item => item.kind === mapping.kind && item.model === mapping.model.trim())) { setMessage('该旧型号已有映射'); return; }
              setDraft({ ...draft, models: [...draft.models, { ...mapping, model: mapping.model.trim() }] }); setMapping(current => ({ ...current, model: '', ruleId: '' }));
            }}><Plus size={16} aria-hidden="true" /></button>
          </div>
          <p className={styles.muted}>auto / xhigh 按当前类型默认档作历史折算</p>
        </details>
        <div className={styles.referenceToolbar}>
          <div role="status" aria-live="polite">{message}{storageIssue && <p>本地记录暂不可用，草稿仍保留在当前页；服务端已成功的保存不受影响。</p>}</div>
          <div className={styles.tools}>{pending ? <button type="button" disabled={busy} onClick={() => void queryOperation(pending)}><RefreshCw size={16} aria-hidden="true" />核对原保存</button>
            : <button type="button" className="btn btn-primary" disabled={busy || reading || !dirty || operationIssue} onClick={() => void save()}><Save size={16} aria-hidden="true" />{busy ? '正在保存' : '保存参考标价'}</button>}</div>
        </div>
      </>}
    </div>}
  </details>{productDialog}</>;
}
