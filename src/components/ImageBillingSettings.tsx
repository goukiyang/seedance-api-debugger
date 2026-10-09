'use client';
import { useEffect, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { IMAGE_STUDIO_MODEL_LABELS } from '@/lib/image-studio/model-catalog';
import { useProductDialog } from '@/components/useProductDialog';

type State = { enabled: boolean; revision: number; models: Record<string, { exactPostBill: boolean; ready: boolean }> };
export function ImageBillingSettings() {
  const [value, setValue] = useState<State | null>(null), [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { confirm, productDialog } = useProductDialog();
  async function read() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/image-studio/billing', { cache: 'no-store' });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || '读取失败');
      setValue(next); setEnabled(next.enabled);
    } catch (error) { setError(error instanceof Error ? error.message : '读取失败'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void read(); }, []);
  async function save() {
    if (!value || busy) return;
    if (enabled && !await confirm('仅对已精确核对过账单的模型开放新图片实扣报价。35点/USD，倍率1，精度0.01点；旧任务及视频合同不变。', { title: '启用实扣', confirmLabel: '确认保存' })) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/image-studio/billing', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, revision: value.revision, confirmNewImageActualBilling: true }) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || '保存失败');
      setValue(next); setEnabled(next.enabled);
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }
  return <section className="panel" style={{ marginTop: 16 }}>
    <div className="panel-header"><h2>图片实扣</h2><button type="button" aria-label="重新核对计费状态" title="重新核对计费状态" disabled={busy} onClick={() => void read()}><RefreshCw size={16} /></button></div>
    <label><input type="checkbox" checked={enabled} disabled={!value || busy} onChange={event => setEnabled(event.target.checked)} />允许已核对模型提供新实扣报价</label>
    <p>35点/USD · 倍率1 · 实扣精度0.01点。未就绪模型保留原固定合同，旧图片不追扣，视频价格不变。</p>
    {value && <dl>{Object.entries(value.models).map(([model, state]) => <div key={model}><dt>{IMAGE_STUDIO_MODEL_LABELS[model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || model}</dt><dd>{!state.exactPostBill ? '生成编号与账单待核对' : !value.enabled ? '已核对，意向关闭' : '可取新报价，仍需有效价格依据'}</dd></div>)}</dl>}
    <button type="button" className="btn-primary" disabled={!value || busy || enabled === value.enabled} onClick={() => void save()}><Save size={16} />{busy ? '处理中' : '保存'}</button>
    {error && <p role="alert">{error}</p>}{productDialog}
  </section>;
}
