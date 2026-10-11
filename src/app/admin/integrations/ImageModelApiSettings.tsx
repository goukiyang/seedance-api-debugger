'use client';

import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import type { ImageModelApiFormDto, ImageModelApiSaveReceipt } from '@/lib/integrations/image-generation';
import type { ImageGenerationDefaultRoutesDto } from '@/lib/integrations/image-generation-defaults';

type Props = {
  accountId: string | null; onDraftChange: (drafts: Record<string, boolean>, ready: boolean) => void;
  onSaveStart: () => boolean; onSaveFinish: (model: string, saved: boolean) => void;
};
type PendingSave = { mutationId: string; model: ImageStudioModel; channelId: string; accountId: string };
const draftKey = (model: string, provider: string) => `${model}:${provider}`;

export default function ImageModelApiSettings({ accountId, onDraftChange, onSaveStart, onSaveFinish }: Props) {
  const [forms, setForms] = useState<ImageModelApiFormDto[] | null>(null);
  const [defaults, setDefaults] = useState<ImageGenerationDefaultRoutesDto | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [message, setMessage] = useState<Record<string, string>>({});
  const [readError, setReadError] = useState('');
  const [needsRead, setNeedsRead] = useState(false);
  const generation = useRef(0);
  const lock = useRef(false);
  const activeSave = useRef<string | null>(null);
  const finish = useRef(onSaveFinish); finish.current = onSaveFinish;
  const account = useRef(accountId); account.current = accountId;
  const position = useRef<{ user: string; y: number; initialY: number; moved: boolean; restored: boolean } | null>(null);
  const dirty = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, Boolean(forms && (
    choices[model] !== forms.find(form => form.model === model)?.defaultChannelId
    || Object.entries(keys).some(([id, value]) => id.startsWith(`${model}:`) && Boolean(value.trim()))))]));

  useEffect(() => { onDraftChange(dirty, Boolean(forms && defaults)); }, [JSON.stringify(dirty), Boolean(forms && defaults), onDraftChange]);

  async function read(preserve = false) {
    const epoch = generation.current, user = account.current;
    try {
      const response = await fetch('/api/admin/integrations/image-generation?view=model-api', { cache: 'no-store' });
      const data = await response.json();
      if (generation.current !== epoch || account.current !== user) return;
      if (!response.ok || data.ok !== true || !Array.isArray(data.forms) || data.forms.length !== IMAGE_STUDIO_MODELS.length
        || new Set(data.forms.map((form: ImageModelApiFormDto) => form.model)).size !== IMAGE_STUDIO_MODELS.length
        || !data.forms.every((form: ImageModelApiFormDto) => IMAGE_STUDIO_MODELS.includes(form.model)
          && typeof form.defaultChannelId === 'string' && Array.isArray(form.providers)
          && form.providers.every(provider => typeof provider.id === 'string' && typeof provider.label === 'string'
            && typeof provider.canSave === 'boolean' && typeof provider.apiKeyConfigured === 'boolean'
            && /^[a-f0-9]{64}$/.test(provider.sourceRevision)))
        || !Number.isSafeInteger(data.defaultRoutes?.revision) || !data.defaultRoutes.models
        || typeof data.defaultRoutes.models !== 'object') throw new Error(data.error || '未读取到完整图片设置，未按空设置处理。');
      setForms(data.forms); setDefaults(data.defaultRoutes); setReadError(''); setNeedsRead(false);
      setChoices(current => Object.fromEntries(data.forms.map((form: ImageModelApiFormDto) => [form.model,
        preserve && current[form.model] !== forms?.find(old => old.model === form.model)?.defaultChannelId
          ? current[form.model] || form.defaultChannelId : form.defaultChannelId])));
    } catch (error) {
      if (generation.current === epoch && account.current === user) setReadError(error instanceof Error ? error.message : '读取图片设置失败');
    }
  }
  useEffect(() => {
    generation.current++; lock.current = false;
    setKeys({}); setPending(null); setChoices({}); setForms(null); setDefaults(null); setBusy(null); setMessage({}); setReadError(''); setNeedsRead(false);
    if (accountId) void read();
    return () => {
      generation.current++;
      if (activeSave.current) { finish.current(activeSave.current, false); activeSave.current = null; }
    };
  }, [accountId]);

  useEffect(() => {
    position.current = null;
    if (!accountId) return;
    const storageKey = `sd2-admin-image-api-position-v1:${accountId}`;
    let y = 0;
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (value && typeof value === 'object' && Number.isFinite((value as { y?: unknown }).y)
        && Number((value as { y?: unknown }).y) >= 0 && Number((value as { y?: unknown }).y) <= 10_000_000) y = Number((value as { y?: unknown }).y);
    } catch { /* Position recovery must not block settings. */ }
    const state = { user: accountId, y, initialY: window.scrollY, moved: false, restored: false };
    position.current = state;
    const moved = () => { state.moved = true; };
    const remember = () => {
      if (!state.restored || account.current !== accountId) return;
      try { localStorage.setItem(storageKey, JSON.stringify({ y: window.scrollY })); } catch { /* No credentials are persisted. */ }
    };
    window.addEventListener('wheel', moved, { passive: true });
    window.addEventListener('touchstart', moved, { passive: true });
    window.addEventListener('keydown', moved);
    window.addEventListener('scroll', remember, { passive: true });
    return () => {
      window.removeEventListener('wheel', moved); window.removeEventListener('touchstart', moved);
      window.removeEventListener('keydown', moved); window.removeEventListener('scroll', remember);
    };
  }, [accountId]);
  useEffect(() => {
    const state = position.current;
    if (!forms || !state || state.restored || state.user !== accountId) return;
    const frame = requestAnimationFrame(() => {
      if (position.current !== state) return;
      if (!state.moved && window.scrollY === state.initialY && state.initialY === 0 && !location.hash && !location.search) {
        window.scrollTo({ top: state.y, behavior: 'auto' });
      }
      state.restored = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [forms, accountId]);

  function applyReceipt(receipt: ImageModelApiSaveReceipt, operation: PendingSave) {
    if (receipt.mutationId !== operation.mutationId || receipt.model !== operation.model || receipt.channelId !== operation.channelId
      || receipt.apiKeyConfigured !== true || !Number.isSafeInteger(receipt.defaultRoutes?.revision)
      || receipt.defaultRoutes.models[operation.model] !== operation.channelId) throw new Error('保存回执与本次操作不符，仍需查询原回执。');
    setKeys(current => ({ ...current, [draftKey(operation.model, operation.channelId)]: '' }));
    setForms(current => current?.map(form => form.model === operation.model ? { ...form, defaultChannelId: operation.channelId,
      providers: form.providers.map(provider => provider.id === operation.channelId ? { ...provider, apiKeyConfigured: true } : provider) } : form) || null);
    setDefaults(receipt.defaultRoutes); setPending(null);
    setMessage(current => ({ ...current, [operation.model]: '已保存，后续新任务使用此供应商；未发测试或生成请求。' }));
  }

  async function save(model: ImageStudioModel) {
    const form = forms?.find(item => item.model === model);
    const provider = form?.providers.find(item => item.id === choices[model]);
    if (!accountId || !defaults || !provider || !provider.canSave || pending || needsRead || lock.current || !onSaveStart()) return;
    const operation: PendingSave = { mutationId: crypto.randomUUID(), model, channelId: provider.id, accountId };
    const epoch = generation.current;
    activeSave.current = model;
    lock.current = true; setBusy(model); setMessage(current => ({ ...current, [model]: '' }));
    let saved = false, definiteFailure = false;
    try {
      const response = await fetch('/api/admin/integrations/image-generation', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_action: 'save-model-api', mutation_id: operation.mutationId, model, channelId: provider.id,
          apiKey: keys[draftKey(model, provider.id)] || '', expectedRevision: provider.revision,
          expectedSourceRevision: provider.sourceRevision, expectedDefaultRevision: defaults.revision }) });
      const data = await response.json();
      if (generation.current !== epoch || account.current !== operation.accountId) return;
      if (!response.ok && response.status < 500 && data.code !== 'image_model_save_unknown') {
        definiteFailure = true;
        if (response.status === 409) {
          setNeedsRead(true); setReadError('保存版本或可用条件已变化，输入已保留。请重新读取后核对。');
        }
        throw new Error(data.error || '保存失败，输入已保留。');
      }
      if (!response.ok || data.ok !== true || !data.receipt) throw new Error('保存结果未确认，请查询原保存回执。');
      applyReceipt(data.receipt, operation); saved = true;
      await read(true);
    } catch (error) {
      if (generation.current !== epoch || account.current !== operation.accountId) return;
      if (!definiteFailure) setPending(operation);
      setMessage(current => ({ ...current, [model]: error instanceof Error ? error.message : '保存结果未确认，输入已保留。' }));
    } finally {
      if (generation.current === epoch && account.current === operation.accountId) {
        lock.current = false; setBusy(null);
        const otherKeyDraft = Object.entries(keys).some(([id, value]) => id.startsWith(`${model}:`) && id !== draftKey(model, provider.id) && Boolean(value.trim()));
        activeSave.current = null; onSaveFinish(model, saved && !otherKeyDraft);
      }
    }
  }

  async function queryReceipt() {
    const operation = pending;
    if (!operation || lock.current || !onSaveStart()) return;
    const epoch = generation.current;
    activeSave.current = operation.model;
    lock.current = true; setBusy(operation.model);
    let saved = false;
    try {
      const response = await fetch(`/api/admin/integrations/image-generation?mutation_id=${encodeURIComponent(operation.mutationId)}`, { cache: 'no-store' });
      const data = await response.json();
      if (generation.current !== epoch || account.current !== operation.accountId) return;
      if (!response.ok || data.ok !== true) throw new Error(data.error || '原回执暂不可读取。');
      if (!data.found || !data.receipt) throw new Error('尚未找到原保存回执；输入和原操作编号已保留，不会重新提交。');
      applyReceipt(data.receipt, operation); saved = true; await read(true);
    } catch (error) {
      if (generation.current === epoch && account.current === operation.accountId) setMessage(current => ({ ...current,
        [operation.model]: error instanceof Error ? error.message : '原保存回执未确认。' }));
    } finally {
      if (generation.current === epoch && account.current === operation.accountId) {
        lock.current = false; setBusy(null);
        const otherKeyDraft = Object.entries(keys).some(([id, value]) => id.startsWith(`${operation.model}:`)
          && id !== draftKey(operation.model, operation.channelId) && Boolean(value.trim()));
        activeSave.current = null; onSaveFinish(operation.model, saved && !otherKeyDraft);
      }
    }
  }

  return <div>
    {readError && <div className="alert alert-error" role="alert">{readError}
      <button type="button" className="btn btn-secondary" disabled={Boolean(busy || pending)} onClick={() => void read(Boolean(forms))}>重新读取</button>
    </div>}
    {!forms && !readError && <p role="status">正在读取图片设置</p>}
    {['Image', 'Banana'].map(group => <section key={group} aria-label={`${group}图片生成`} style={{ padding: '24px 0', borderTop: '1px solid var(--border-color)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h2 className="section-title">{group}</h2>
        {group === 'Image' && <button type="button" className="btn btn-secondary" title="重置页面位置" aria-label="重置页面位置"
          onClick={() => {
            if (accountId) { try { localStorage.removeItem(`sd2-admin-image-api-position-v1:${accountId}`); } catch { /* Safe preference only. */ } }
            window.scrollTo({ top: 0, behavior: 'auto' });
          }}><RotateCcw size={16} aria-hidden="true" /></button>}
      </div>
      {IMAGE_STUDIO_MODELS.filter(model => group === 'Banana' ? model.startsWith('gemini-') : !model.startsWith('gemini-')).map(model => {
        const form = forms?.find(item => item.model === model);
        const provider = form?.providers.find(item => item.id === choices[model]);
        return <form key={model} onSubmit={event => { event.preventDefault(); void save(model); }} style={{ maxWidth: 640, padding: '16px 0', minWidth: 0 }}>
          <h3 style={{ fontSize: 16, margin: '0 0 12px' }}>{IMAGE_STUDIO_MODEL_LABELS[model]}</h3>
          <fieldset disabled={Boolean(busy || pending) || needsRead || !form} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="form-group"><label className="form-label" htmlFor={`image-provider-${model}`}>供应商</label>
              <select id={`image-provider-${model}`} className="input" value={choices[model] || ''} onChange={event => setChoices(current => ({ ...current, [model]: event.target.value }))}>
                {!provider && <option value={choices[model] || ''}>{choices[model] ? '已保存供应商不可用' : '选择供应商'}</option>}
                {form?.providers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select></div>
            <div className="form-group"><label className="form-label" htmlFor={`image-key-${model}`}>API Key</label>
              <input id={`image-key-${model}`} type="password" className="input" autoComplete="new-password" maxLength={500}
                value={keys[draftKey(model, choices[model])] || ''} onChange={event => setKeys(current => ({ ...current, [draftKey(model, choices[model])]: event.target.value }))}
                placeholder={provider?.apiKeyConfigured ? '已设置，留空保留' : '输入该供应商的API Key'} disabled={!provider} /></div>
            {provider?.reason && <p role="status" className="text-gray text-sm">{provider.reason}</p>}
            <div className="codex-config-actions"><button type="submit" className="btn btn-primary sd2-loading-surface"
              data-busy={busy === model} disabled={!provider?.canSave || !defaults || !dirty[model]}>{busy === model ? '正在保存' : '保存'}</button></div>
          </fieldset>
          {message[model] && <p role="status" className="text-sm">{message[model]}</p>}
          {pending?.model === model && <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void queryReceipt()}>查询原保存回执</button>}
        </form>;
      })}
    </section>)}
  </div>;
}
