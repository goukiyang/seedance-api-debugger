'use client';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { IMAGE_STUDIO_MODEL_LABELS } from '@/lib/image-studio/model-catalog';
import { useProductDialog } from '@/components/useProductDialog';

type ModelState = { exactPostBill: boolean; eligibleForIntent?: boolean; eligibilityReason?: string; ready: boolean };
type State = { enabled: boolean; enabledModels: string[]; revision: number; models: Record<string, ModelState> };
const modelLabel = (model: string) => IMAGE_STUDIO_MODEL_LABELS[model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || model;
const sameModels = (left: string[], right: string[]) => left.length === right.length && left.every(model => right.includes(model));
function readState(input: unknown): State {
  if (!input || typeof input !== 'object') throw new Error('计费状态不完整，请重新读取');
  const next = input as State;
  if (typeof next.enabled !== 'boolean' || !Number.isSafeInteger(next.revision) || next.revision < 0
    || !next.models || typeof next.models !== 'object' || Array.isArray(next.models)
    || !Array.isArray(next.enabledModels) || next.enabledModels.some(model => typeof model !== 'string' || !Object.hasOwn(next.models, model))
    || Object.values(next.models).some(state => !state || typeof state.exactPostBill !== 'boolean' || typeof state.ready !== 'boolean'
      || (state.eligibleForIntent !== undefined && typeof state.eligibleForIntent !== 'boolean'))) {
    throw new Error('计费状态不完整，请重新读取');
  }
  return { ...next, enabledModels: Array.from(new Set(next.enabledModels)) };
}
const canSelectModel = (state?: ModelState) => state?.exactPostBill === true && state.eligibleForIntent === true;
export function ImageBillingSettings() {
  const [value, setValue] = useState<State | null>(null), [enabled, setEnabled] = useState(false);
  const [enabledModels, setEnabledModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const operation = useRef(false);
  const { confirm, productDialog } = useProductDialog();
  const changed = Boolean(value && (enabled !== value.enabled || !sameModels(enabledModels, value.enabledModels)));
  const unavailableSelection = enabledModels.some(model => !canSelectModel(value?.models[model]));
  const saveBlocked = enabled && (!enabledModels.length || unavailableSelection);
  function apply(next: State) {
    setValue(next); setEnabled(next.enabled); setEnabledModels(next.enabledModels);
  }
  async function read() {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (changed && !await confirm('重新读取会替换尚未保存的总开关和模型选择，是否继续？', { title: '重新读取', confirmLabel: '放弃修改并读取' })) return;
      const response = await fetch('/api/admin/image-studio/billing', { cache: 'no-store' });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || '读取失败');
      apply(readState(next));
    } catch (error) { setError(error instanceof Error ? error.message : '读取失败'); }
    finally { operation.current = false; setBusy(false); }
  }
  useEffect(() => { void read(); }, []);
  async function save() {
    if (!value || operation.current || !changed) return;
    if (saveBlocked) { setError('请仅选择已核对且具备启用资格的模型；尚未保存。'); return; }
    const submission = { enabled, enabledModels: [...enabledModels], revision: value.revision, confirmNewImageActualBilling: true };
    operation.current = true; setBusy(true); setError(''); setNotice('');
    const persist = async () => {
      const response = await fetch('/api/admin/image-studio/billing', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission) });
      const next = await response.json();
      if (!response.ok) throw new Error(response.status === 409 ? '计费设置已变化，请取消并重新读取后再保存。' : next.error || '保存失败');
      const saved = readState(next);
      if (saved.revision !== submission.revision + 1 || saved.enabled !== submission.enabled || !sameModels(saved.enabledModels, submission.enabledModels)) {
        throw new Error('返回的设置与本次提交不一致，保存结果尚未确认；请取消并重新读取。');
      }
      apply(saved);
      setNotice(saved.enabled ? '所选模型的实扣意向已保存；新实扣仍须价格依据核对与有效报价。' : '总开关已关闭，新图片沿用原固定合同。');
    };
    try {
      if (submission.enabled) {
        await confirm(`仅保存以下模型的新图片实扣意向：${submission.enabledModels.map(modelLabel).join('、')}。每次实扣仍须取得有效报价。35点/USD，倍率1，精度0.01点；旧任务及视频合同不变。`,
          { title: '启用实扣', confirmLabel: '确认保存', onSubmit: persist });
      } else await persist();
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); }
    finally { operation.current = false; setBusy(false); }
  }
  return <section className="panel" style={{ marginTop: 16 }}>
    <div className="panel-header"><h2>图片实扣</h2><button type="button" aria-label="重新核对计费状态" title="重新核对计费状态" disabled={busy} onClick={() => void read()}><RefreshCw size={16} /></button></div>
    <label><input type="checkbox" checked={enabled} disabled={!value || busy} onChange={event => { setEnabled(event.target.checked); setNotice(''); }} />允许所选模型提供新实扣报价</label>
    <p>35点/USD · 倍率1 · 实扣精度0.01点。仅价格依据核对通过并取得有效报价的新图片可实扣，旧图片不追扣，视频价格不变。</p>
    {value && <fieldset style={{ border: 0, padding: 0, margin: '16px 0', minWidth: 0 }}>
      <legend>实扣模型</legend>
      <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>{Object.entries(value.models).map(([model, state]) => {
        const checked = enabledModels.includes(model), selectable = canSelectModel(state);
        return <label key={model} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <input type="checkbox" checked={checked} disabled={busy || (!checked && !selectable)} onChange={event => {
            const selected = event.target.checked;
            if (selected && !selectable) return;
            setEnabledModels(current => selected ? Array.from(new Set([...current, model])) : current.filter(value => value !== model));
            setNotice('');
          }} />
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{modelLabel(model)}
            <small style={{ display: 'block', color: 'var(--text-secondary)' }}>{!state.exactPostBill ? '待核：生成请求与账单尚未精确对应' : !selectable ? state.eligibilityReason === 'price_rule_unavailable' ? '报价依据暂不可用，不可勾选' : '启用资格待核，暂不可勾选' : value.enabled && value.enabledModels.includes(model) ? '已保存实扣意向；取得有效报价后才可实扣' : value.enabledModels.includes(model) ? '已选模型，总开关关闭' : '已核对，可选择实扣意向；尚未启用'}</small>
          </span>
        </label>;
      })}</div>
    </fieldset>}
    {changed && <p role="status">修改尚未保存。{saveBlocked ? '需选择具备启用资格的模型，待核模型不可启用。' : ''}</p>}
    <button type="button" className="btn-primary" disabled={!value || busy || !changed || saveBlocked} onClick={() => void save()}><Save size={16} />{busy ? '处理中' : '保存'}</button>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}{productDialog}
  </section>;
}
