'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RelativeTime } from '@/components/RelativeTime';
import { IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import type { ImageModelApiFormDto, ImageModelApiSaveReceipt } from '@/lib/integrations/image-generation';
import type { ImageGenerationDefaultRoutesDto } from '@/lib/integrations/image-generation-defaults';

type Operation = { accountId: string; mutationId: string; model: ImageStudioModel; channelId: string; defaultRevision: number };
type Props = {
  accountId: string | null; model: ImageStudioModel; blocked: boolean; revision?: number;
  onStateChange: (dirty: boolean, pending: boolean) => void;
  onSaveStart: () => boolean; onSaveFinish: (saved: boolean) => void; onSaved: () => void;
  onOpenGroup: (model: ImageStudioModel) => void;
};
const endpoint = '/api/admin/integrations/image-generation';
const keyFor = (user: string) => `sd2-admin-image-model-operation-v1:${user}`;

export default function ImageModelObjectSettings({ accountId, model, blocked, revision, onStateChange, onSaveStart, onSaveFinish, onSaved, onOpenGroup }: Props) {
  const [forms, setForms] = useState<ImageModelApiFormDto[] | null>(null);
  const [defaults, setDefaults] = useState<ImageGenerationDefaultRoutesDto | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [needsRead, setNeedsRead] = useState(false);
  const [message, setMessage] = useState(''), [receipt, setReceipt] = useState<ImageModelApiSaveReceipt | null>(null);
  const epoch = useRef(0), sequence = useRef(0), lock = useRef(false), account = useRef(accountId);
  account.current = accountId;
  const callbacks = useRef({ onStateChange, onSaveFinish, onSaved });
  callbacks.current = { onStateChange, onSaveFinish, onSaved };
  const dirty = Boolean(pending || Object.values(keys).some(Boolean) || forms?.some(form => choices[form.model] && choices[form.model] !== form.defaultChannelId));
  useEffect(() => { callbacks.current.onStateChange(dirty, Boolean(pending || busy)); }, [dirty, pending, busy]);

  async function read() {
    const generation = epoch.current, seq = ++sequence.current, owner = account.current;
    setReading(true);
    try {
      const response = await fetch(`${endpoint}?view=model-api`, { cache: 'no-store' });
      const data = await response.json();
      if (generation !== epoch.current || seq !== sequence.current || owner !== account.current) return;
      if (!response.ok || data.ok !== true || !Array.isArray(data.forms) || data.forms.length !== IMAGE_STUDIO_MODELS.length
        || new Set(data.forms.map((form: ImageModelApiFormDto) => form.model)).size !== IMAGE_STUDIO_MODELS.length
        || !data.forms.every((form: ImageModelApiFormDto) => IMAGE_STUDIO_MODELS.includes(form.model)
          && typeof form.defaultChannelId === 'string' && Array.isArray(form.providers)
          && form.providers.every(provider => typeof provider.id === 'string' && typeof provider.label === 'string'
            && typeof provider.canSave === 'boolean' && typeof provider.apiKeyConfigured === 'boolean'
            && /^[a-f0-9]{64}$/.test(provider.sourceRevision)
            && (provider.revision === null || typeof provider.revision === 'string')))
        || !Number.isSafeInteger(data.defaultRoutes?.revision) || !data.defaultRoutes.models) throw new Error(data.error || '未读到完整型号配置，原输入已保留。');
      setChoices(current => Object.fromEntries(data.forms.map((form: ImageModelApiFormDto) => [form.model,
        current[form.model] && current[form.model] !== forms?.find(old => old.model === form.model)?.defaultChannelId
          ? current[form.model] : form.defaultChannelId])));
      setForms(data.forms); setDefaults(data.defaultRoutes); setNeedsRead(false);
    } catch (error) {
      if (generation === epoch.current && seq === sequence.current && owner === account.current) {
        setNeedsRead(true); setMessage(error instanceof Error ? error.message : '型号配置读取失败，输入已保留。');
      }
    } finally {
      if (generation === epoch.current && seq === sequence.current && owner === account.current) setReading(false);
    }
  }
  useEffect(() => {
    epoch.current++; lock.current = false; setForms(null); setDefaults(null); setChoices({}); setKeys({});
    setPending(null); setBusy(false); setMessage(''); setReceipt(null); setNeedsRead(false);
    if (accountId) {
      try {
        const saved = JSON.parse(localStorage.getItem(keyFor(accountId)) || 'null');
        if (saved?.accountId === accountId && /^[A-Za-z0-9_-]{1,160}$/.test(saved.mutationId)
          && IMAGE_STUDIO_MODELS.includes(saved.model) && typeof saved.channelId === 'string' && saved.channelId.length <= 120
          && Number.isSafeInteger(saved.defaultRevision) && saved.defaultRevision >= 0) {
          setPending(saved); setMessage('上次保存结果待确认，请查询原回执。Key 未保存在浏览器。');
        }
      } catch { /* Recovery contains only the original operation identity. */ }
      void read();
    }
    return () => { epoch.current++; sequence.current++; if (lock.current) callbacks.current.onSaveFinish(false); };
  }, [accountId]);
  useEffect(() => { if (accountId && forms && !lock.current && !pending) void read(); }, [revision]);

  function forget(operation: Operation) {
    try {
      const saved = JSON.parse(localStorage.getItem(keyFor(operation.accountId)) || 'null');
      if (saved?.mutationId === operation.mutationId) localStorage.removeItem(keyFor(operation.accountId));
    } catch { /* The server receipt remains authoritative. */ }
  }
  async function execute(operation: Operation, request: () => Promise<Response>, querying: boolean) {
    const generation = epoch.current;
    lock.current = true; setBusy(true); setMessage('');
    let saved = false, rejected = false;
    try {
      const response = await request(), data = await response.json();
      if (generation !== epoch.current || operation.accountId !== account.current) return;
      rejected = !querying && !response.ok && response.status < 500 && data.code !== 'image_model_save_unknown';
      if (!response.ok || data.ok !== true || !data.receipt) throw new Error(data.error || (querying ? '尚未找到原回执，不会重新提交。' : '保存结果待确认，请查询原回执。'));
      const result: ImageModelApiSaveReceipt = data.receipt;
      if (result.mutationId !== operation.mutationId || result.model !== operation.model || result.channelId !== operation.channelId
        || result.defaultRoutes?.revision !== operation.defaultRevision + 1 || result.defaultRoutes.models[operation.model] !== operation.channelId
        || typeof result.enabled !== 'boolean' || typeof result.apiKeyConfigured !== 'boolean' || !Number.isFinite(Date.parse(result.savedAt))) {
        throw new Error('保存回执与原操作不符，仍需查询原回执。');
      }
      forget(operation); setPending(null); saved = true; setReceipt(result);
      setKeys(current => { const next = { ...current }; delete next[`${operation.model}:${operation.channelId}`]; return next; });
      setChoices(current => ({ ...current, [operation.model]: operation.channelId }));
      setForms(current => current?.map(form => form.model === operation.model ? { ...form, defaultChannelId: operation.channelId } : form) || null);
      setDefaults(result.defaultRoutes);
      const supplier = forms?.find(item => item.model === operation.model)?.providers.find(item => item.id === operation.channelId)?.label || operation.channelId;
      setMessage(`${IMAGE_STUDIO_MODEL_LABELS[operation.model]} 已保存，默认供应商：${supplier}，修订 ${result.defaultRoutes.revision}。仅影响未来新请求；旧报价、已受理和结果未知的任务仍使用原配置。`);
      await read(); callbacks.current.onSaved();
    } catch (error) {
      if (generation !== epoch.current || operation.accountId !== account.current) return;
      if (rejected) { forget(operation); if (error instanceof Error) setNeedsRead(true); }
      else if (!saved) setPending(operation);
      setMessage(error instanceof Error ? error.message : '保存结果待确认，输入已保留。');
    } finally {
      if (generation === epoch.current && operation.accountId === account.current) {
        const otherDrafts = Object.entries(keys).some(([key, value]) => key !== `${operation.model}:${operation.channelId}` && Boolean(value))
          || forms?.some(form => form.model !== operation.model && choices[form.model] && choices[form.model] !== form.defaultChannelId);
        lock.current = false; setBusy(false); callbacks.current.onSaveFinish(saved && !otherDrafts);
      }
    }
  }
  async function save() {
    const form = forms?.find(item => item.model === model), provider = form?.providers.find(item => item.id === choices[model]);
    if (!accountId || !defaults || !provider?.canSave || pending || busy || blocked || needsRead || reading || lock.current || !onSaveStart()) return;
    const operation: Operation = { accountId, mutationId: crypto.randomUUID(), model, channelId: provider.id, defaultRevision: defaults.revision };
    const body = { channel_action: 'save-model-api', mutation_id: operation.mutationId, model, channelId: provider.id,
      apiKey: keys[`${model}:${provider.id}`] || '', expectedRevision: provider.revision,
      expectedSourceRevision: provider.sourceRevision, expectedDefaultRevision: defaults.revision };
    try { localStorage.setItem(keyFor(accountId), JSON.stringify(operation)); } catch { /* In-memory original identity remains available. */ }
    await execute(operation, () => fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), false);
  }
  async function query() {
    if (!pending || lock.current || blocked || !onSaveStart()) return;
    await execute(pending, () => fetch(`${endpoint}?mutation_id=${encodeURIComponent(pending.mutationId)}`, { cache: 'no-store' }), true);
  }
  const form = forms?.find(item => item.model === model), provider = form?.providers.find(item => item.id === choices[model]);
  const locked = busy || blocked || Boolean(pending) || reading || needsRead || !form;
  return <section aria-label={IMAGE_STUDIO_MODEL_LABELS[model]} style={{ padding: '20px 0', minWidth: 0 }}>
    <h2 className="section-title">{IMAGE_STUDIO_MODEL_LABELS[model]}</h2>
    {!forms && reading && <p role="status">正在读取型号配置</p>}
    {form && <p className="text-gray text-sm">当前默认供应商：{form.providers.find(item => item.id === form.defaultChannelId)?.label || form.defaultChannelId} · 配置修订 {defaults?.revision}</p>}
    <form onSubmit={event => { event.preventDefault(); void save(); }} style={{ maxWidth: 640 }}>
      <fieldset disabled={locked} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <label className="form-group" style={{ display: 'block' }}><span className="form-label">新请求的供应商</span>
          <select className="input" value={choices[model] || ''} onChange={event => setChoices(current => ({ ...current, [model]: event.target.value }))}>
            {!provider && <option value="">请选择供应商</option>}
            {form?.providers.map(item => <option key={item.id} value={item.id} disabled={!item.canSave}>{item.label}</option>)}
          </select>
        </label>
        {provider && <p className="text-gray text-sm">{provider.reason || '当前配置可用于新请求'}。API Key {provider.apiKeyConfigured ? '已设置' : '未设置'}；独立型号开关、费率和继承关系保持原配置。</p>}
        <details><summary>型号 Key 与更多配置</summary>
          <label className="form-group" style={{ display: 'block', marginTop: 12 }}><span className="form-label">此型号独立 API Key</span>
            <input className="input" type="password" autoComplete="new-password" maxLength={500} disabled={!provider}
              value={keys[`${model}:${provider?.id}`] || ''} placeholder="留空保留当前 Key 或继承关系"
              onChange={event => { if (provider) setKeys(current => ({ ...current, [`${model}:${provider.id}`]: event.target.value })); }} />
          </label>
          <button type="button" className="btn btn-secondary" onClick={() => onOpenGroup(model)}>地址、协议、启停与规格设置</button>
          <p className="text-gray text-sm">这些设置沿用原整组编辑入口，整组保存的影响范围会单独显示。</p>
        </details>
        <p className="text-gray text-sm">保存只影响此型号未来新请求。旧报价、已受理及结果未知的任务保留原 configRevision，不重新提交。</p>
        <button type="submit" className="btn btn-primary" disabled={!provider?.canSave || (!keys[`${model}:${provider?.id}`] && choices[model] === form?.defaultChannelId)}>{busy ? '正在保存' : '保存此型号'}</button>
        <Link className="btn btn-secondary" href={`/admin/pricing?search=${encodeURIComponent(model)}`}>点数与费率</Link>
      </fieldset>
    </form>
    {message && <p role="status" className="text-gray text-sm">{message}</p>}
    {receipt && <p className="text-gray text-sm">{IMAGE_STUDIO_MODEL_LABELS[receipt.model]} · 修订 {receipt.defaultRoutes.revision} · <RelativeTime value={receipt.savedAt} /></p>}
    {pending && <button type="button" className="btn btn-secondary" disabled={busy || blocked} onClick={() => void query()}>查询原保存回执</button>}
    {needsRead && !pending && <button type="button" className="btn btn-secondary" disabled={busy || blocked || reading} onClick={() => void read()}>重新读取，保留输入</button>}
  </section>;
}
