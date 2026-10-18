'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Pencil, RotateCcw } from 'lucide-react';
import { useProductDialog } from '@/components/useProductDialog';
import { IMAGE_STUDIO_MODEL_LABELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { IMAGE_API_GROUPS, imageApiGroupModels, type ImageApiGroup, type ImageApiGroupFormDto, type ImageApiGroupProviderDto, type ImageApiGroupSaveReceipt } from '@/lib/integrations/image-generation-channel';
import type { ImageGenerationDefaultRoutesDto } from '@/lib/integrations/image-generation-defaults';
import ImageApiGroupEditor, { ImageApiGroupModelStatuses, type ImageApiGroupDraft } from './ImageApiGroupEditor';

type Props = {
  accountId: string | null; onDraftChange: (drafts: Record<string, boolean>, ready: boolean) => void;
  onSaveStart: () => boolean; onSaveFinish: (group: string, saved: boolean) => void;
};
type PendingSave = { mutationId: string; group: ImageApiGroup; providerId: string; accountId: string; editor: boolean; draft: ImageApiGroupDraft; defaultRevision: number };
type Editor = { group: ImageApiGroup; providerId: string; initial: ImageApiGroupDraft };
const draftKey = (group: string, provider: string) => `${group}:${provider}`;
const baseDraft = (form: ImageApiGroupFormDto, provider: ImageApiGroupProviderDto): ImageApiGroupDraft => ({
  apiKey: '', clearApiKey: false, enabled: provider.groupConfigured || form.defaultProviderId === provider.id ? provider.enabled : false, settings: {}, models: {},
});
const pendingStorageKey = (user: string) => `sd2-admin-image-api-pending-v1:${user}`;
function rememberOperation(operation: PendingSave) {
  try {
    localStorage.setItem(pendingStorageKey(operation.accountId), JSON.stringify({ mutationId: operation.mutationId,
      group: operation.group, providerId: operation.providerId, defaultRevision: operation.defaultRevision, enabled: operation.draft.enabled }));
  } catch { /* Credential-free recovery is best effort; the in-memory operation remains. */ }
}
function forgetOperation(operation: PendingSave) {
  try {
    const value = JSON.parse(localStorage.getItem(pendingStorageKey(operation.accountId)) || 'null');
    if (value?.mutationId === operation.mutationId) localStorage.removeItem(pendingStorageKey(operation.accountId));
  } catch { /* A receipt remains authoritative even when preferences are unavailable. */ }
}

function receiptModelStatuses(receipt: ImageApiGroupSaveReceipt) {
  const models = imageApiGroupModels(receipt.group), statuses = receipt.modelStatuses;
  if (!Array.isArray(receipt.affectedModels) || receipt.affectedModels.length !== models.length
    || new Set(receipt.affectedModels).size !== models.length || !receipt.affectedModels.every(model => models.includes(model))
    || !statuses || !models.every(model => {
      const value = statuses[model];
      return value && typeof value.enabled === 'boolean' && typeof value.ready === 'boolean'
        && typeof value.apiKeyConfigured === 'boolean' && typeof value.apiKeyOverrideConfigured === 'boolean'
        && typeof value.protocolConfigured === 'boolean' && typeof value.configurationReady === 'boolean'
        && Array.isArray(value.missingRequirements) && value.missingRequirements.every(item => typeof item === 'string')
        && Array.isArray(value.blockingReasons) && value.blockingReasons.every(item => typeof item === 'string')
        && value.configurationReady === (value.missingRequirements.length === 0)
        && value.ready === (receipt.enabled && value.enabled && value.configurationReady && value.blockingReasons.length === 0);
    })) return null;
  return Object.fromEntries(models.map(model => [model, statuses[model]!]));
}

export default function ImageModelApiSettings({ accountId, onDraftChange, onSaveStart, onSaveFinish }: Props) {
  const [forms, setForms] = useState<ImageApiGroupFormDto[] | null>(null);
  const [defaults, setDefaults] = useState<ImageGenerationDefaultRoutesDto | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, ImageApiGroupDraft>>({});
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState<ImageApiGroup | null>(null);
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [message, setMessage] = useState<Record<string, string>>({});
  const [readError, setReadError] = useState('');
  const [needsRead, setNeedsRead] = useState(false);
  const { confirm, productDialog } = useProductDialog();
  const generation = useRef(0), readSequence = useRef(0), lock = useRef(false);
  const activeSave = useRef<string | null>(null), finish = useRef(onSaveFinish); finish.current = onSaveFinish;
  const account = useRef(accountId); account.current = accountId;
  const position = useRef<{ user: string; y: number; initialY: number; moved: boolean; restored: boolean } | null>(null);
  function groupHasDraft(group: ImageApiGroup, omit?: string) {
    const form = forms?.find(item => item.group === group);
    return Object.entries(drafts).some(([id, draft]) => {
      if (!id.startsWith(`${group}:`) || id === omit || !form) return false;
      const provider = form.providers.find(item => id === draftKey(group, item.id));
      return !provider || JSON.stringify(draft) !== JSON.stringify(baseDraft(form, provider));
    });
  }
  const dirty = Object.fromEntries(IMAGE_API_GROUPS.map(group => [group, Boolean(forms && (
    choices[group] !== (forms.find(form => form.group === group)?.defaultProviderId || '') || groupHasDraft(group) || pending?.group === group))]));
  useEffect(() => { onDraftChange(dirty, Boolean(forms && defaults)); }, [JSON.stringify(dirty), Boolean(forms && defaults), onDraftChange]);

  async function read(preserve = false) {
    const epoch = generation.current, sequence = ++readSequence.current, user = account.current;
    setReading(true);
    try {
      const response = await fetch('/api/admin/integrations/image-generation?view=api-groups', { cache: 'no-store' });
      const data = await response.json();
      if (generation.current !== epoch || account.current !== user || sequence !== readSequence.current) return;
      if (!response.ok || data.ok !== true || !Array.isArray(data.forms) || data.forms.length !== IMAGE_API_GROUPS.length
        || new Set(data.forms.map((form: ImageApiGroupFormDto) => form.group)).size !== IMAGE_API_GROUPS.length
        || !data.forms.every((form: ImageApiGroupFormDto) => IMAGE_API_GROUPS.includes(form.group) && Array.isArray(form.providers)
          && (form.defaultProviderId === null || typeof form.defaultProviderId === 'string')
          && form.providers.every(provider => typeof provider.id === 'string' && typeof provider.label === 'string'
            && typeof provider.enabled === 'boolean' && typeof provider.deleted === 'boolean' && typeof provider.groupConfigured === 'boolean'
            && typeof provider.apiKeyConfigured === 'boolean' && provider.settings && provider.models && /^[a-f0-9]{64}$/.test(provider.sourceRevision)))
        || !Number.isSafeInteger(data.defaultRoutes?.revision) || !data.defaultRoutes.models || typeof data.defaultRoutes.models !== 'object') {
        throw new Error(data.error || '未读取到完整图片设置，未按空设置处理。');
      }
      setForms(data.forms); setDefaults(data.defaultRoutes); setReadError(''); setNeedsRead(false);
      setChoices(current => Object.fromEntries(data.forms.map((form: ImageApiGroupFormDto) => [form.group,
        preserve && current[form.group] !== (forms?.find(old => old.group === form.group)?.defaultProviderId || '')
          ? current[form.group] || '' : form.defaultProviderId || ''])));
    } catch (error) {
      if (generation.current === epoch && account.current === user && sequence === readSequence.current) {
        setNeedsRead(true); setReadError(error instanceof Error ? error.message : '读取图片设置失败');
      }
    } finally {
      if (generation.current === epoch && account.current === user && sequence === readSequence.current) setReading(false);
    }
  }
  useEffect(() => {
    generation.current++; lock.current = false;
    setDrafts({}); setPending(null); setChoices({}); setForms(null); setDefaults(null); setEditor(null); setBusy(null); setMessage({}); setReadError(''); setNeedsRead(false);
    if (accountId) {
      try {
        const value = JSON.parse(localStorage.getItem(pendingStorageKey(accountId)) || 'null');
        if (value && typeof value.mutationId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.mutationId)
          && IMAGE_API_GROUPS.includes(value.group) && typeof value.providerId === 'string' && value.providerId.length <= 64
          && typeof value.enabled === 'boolean' && Number.isSafeInteger(value.defaultRevision) && value.defaultRevision >= 0) {
          setPending({ mutationId: value.mutationId, group: value.group, providerId: value.providerId, accountId,
            editor: false, defaultRevision: value.defaultRevision, draft: { apiKey: '', clearApiKey: false, enabled: value.enabled, settings: {}, models: {} } });
          setMessage({ [value.group]: '上次保存结果未确认，请先查原回执；Key 和表单内容未保存在本机。' });
        }
      } catch { /* Invalid local recovery never submits a request. */ }
      void read();
    }
    return () => { generation.current++; if (activeSave.current) { finish.current(activeSave.current, false); activeSave.current = null; } };
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
      try { localStorage.setItem(storageKey, JSON.stringify({ y: window.scrollY })); } catch { /* Only safe position is persisted. */ }
    };
    window.addEventListener('wheel', moved, { passive: true }); window.addEventListener('touchstart', moved, { passive: true });
    window.addEventListener('keydown', moved); window.addEventListener('scroll', remember, { passive: true });
    return () => { window.removeEventListener('wheel', moved); window.removeEventListener('touchstart', moved); window.removeEventListener('keydown', moved); window.removeEventListener('scroll', remember); };
  }, [accountId]);
  useEffect(() => {
    const state = position.current;
    if (!forms || !state || state.restored || state.user !== accountId) return;
    const frame = requestAnimationFrame(() => {
      if (position.current !== state) return;
      if (!state.moved && window.scrollY === state.initialY && state.initialY === 0 && !location.hash && !location.search) window.scrollTo({ top: state.y, behavior: 'auto' });
      state.restored = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [forms, accountId]);

  function changeDraft(group: ImageApiGroup, providerId: string, draft: ImageApiGroupDraft) {
    if (!busy && !pending) setDrafts(current => ({ ...current, [draftKey(group, providerId)]: draft }));
  }
  async function dismissEditor() {
    if (!editor || lock.current) return;
    const epoch = generation.current, target = editor, id = draftKey(target.group, target.providerId);
    const changed = JSON.stringify(drafts[id] || target.initial) !== JSON.stringify(target.initial);
    if (!pending && changed) {
      const discard = await confirm('放弃本次设置层内的修改？打开前的输入会保留。', { title: '关闭设置', confirmLabel: '关闭', anchor: null });
      if (!discard || epoch !== generation.current || lock.current) return;
    }
    if (!pending) setDrafts(current => ({ ...current, [id]: target.initial }));
    setEditor(null);
  }
  function applyReceipt(receipt: ImageApiGroupSaveReceipt, operation: PendingSave) {
    if (receipt.mutationId !== operation.mutationId || receipt.group !== operation.group || receipt.providerId !== operation.providerId
      || typeof receipt.channelId !== 'string' || typeof receipt.apiKeyConfigured !== 'boolean' || receipt.enabled !== operation.draft.enabled
      || receipt.defaultRoutes?.revision !== operation.defaultRevision + 1
      || !imageApiGroupModels(operation.group).every(model => receipt.defaultRoutes.models[model] === receipt.channelId)) {
      throw new Error('保存回执与本次操作不符，仍需查询原回执。');
    }
    const id = draftKey(operation.group, operation.providerId);
    const statuses = receiptModelStatuses(receipt), models = imageApiGroupModels(operation.group);
    const names = (items: ImageStudioModel[]) => items.map(model => IMAGE_STUDIO_MODEL_LABELS[model]).join('、') || '无';
    const readinessMessage = statuses
      ? `配置可用：${names(models.filter(model => statuses[model]?.ready))}；尚不能生成：${names(models.filter(model => !statuses[model]?.ready))}。`
      : '原回执未含完整型号状态，请重新读取核对，不能据此判断可生成。';
    forgetOperation(operation);
    setDrafts(current => {
      if (current[id] && JSON.stringify(current[id]) !== JSON.stringify(operation.draft)) return current;
      const next = { ...current }; delete next[id]; return next;
    });
    setForms(current => current?.map(form => form.group === operation.group ? { ...form, defaultProviderId: operation.providerId,
      defaultChannelIds: Object.fromEntries(imageApiGroupModels(operation.group).map(model => [model, receipt.channelId])),
      providers: form.providers.map(provider => provider.id === operation.providerId ? { ...provider, channelId: receipt.channelId,
        enabled: receipt.enabled, apiKeyConfigured: receipt.apiKeyConfigured, groupConfigured: true,
        models: statuses ? { ...provider.models, ...statuses } : Object.fromEntries(models.flatMap(model => {
          const currentModel = provider.models[model];
          return currentModel ? [[model, { ...currentModel, ready: false, configurationReady: undefined,
            missingRequirements: undefined, blockingReasons: undefined }]] : [];
        })) } : provider) } : form) || null);
    setChoices(current => ({ ...current, [operation.group]: operation.providerId }));
    setDefaults(receipt.defaultRoutes); setPending(null); setNeedsRead(true);
    if (operation.editor) setEditor(current => current?.group === operation.group && current.providerId === operation.providerId ? null : current);
    setMessage(current => ({ ...current, [operation.group]: `${receipt.enabled ? '已保存并启用本组' : '已保存但未启用'}。`
      + `本组 ${models.length} 个型号未来新任务默认已保存，不改变模板选择的型号和已提交任务。`
      + readinessMessage + '连通性与实际出图未验证，未发送生成请求。' }));
  }
  async function runSave(operation: PendingSave, request: () => Promise<Response>) {
    const epoch = generation.current;
    rememberOperation(operation);
    lock.current = true; activeSave.current = operation.group; setBusy(operation.group);
    setMessage(current => ({ ...current, [operation.group]: '' }));
    let saved = false, definiteFailure = false;
    try {
      const response = await request(), data = await response.json();
      if (generation.current !== epoch || account.current !== operation.accountId) return;
      if (!response.ok && response.status < 500 && data.code !== 'image_group_save_unknown') {
        definiteFailure = true;
        forgetOperation(operation);
        if (response.status === 409) { setNeedsRead(true); setReadError('保存版本已变化，输入已保留。请重新读取后核对。'); }
        throw new Error(data.error || '保存失败，输入已保留。');
      }
      if (!response.ok || data.ok !== true || !data.receipt) throw new Error('保存结果未确认，请查询原保存回执。');
      applyReceipt(data.receipt, operation); saved = true;
      await read(true);
    } catch (error) {
      if (generation.current !== epoch || account.current !== operation.accountId) return;
      if (!definiteFailure && !saved) setPending(operation);
      setMessage(current => ({ ...current, [operation.group]: error instanceof Error ? error.message : '保存结果未确认，输入已保留。' }));
    } finally {
      if (generation.current === epoch && account.current === operation.accountId) {
        lock.current = false; activeSave.current = null; setBusy(null);
        const hasOther = groupHasDraft(operation.group, draftKey(operation.group, operation.providerId));
        if (saved) onDraftChange({ ...dirty, [operation.group]: hasOther }, true);
        onSaveFinish(operation.group, saved && !operation.editor && !hasOther);
      }
    }
  }
  async function save(group: ImageApiGroup, fromEditor = false) {
    const form = forms?.find(item => item.group === group), provider = form?.providers.find(item => item.id === choices[group]);
    if (!accountId || !defaults || !form || !provider || provider.deleted || pending || needsRead || reading || lock.current || !onSaveStart()) return;
    const draft = drafts[draftKey(group, provider.id)] || baseDraft(form, provider);
    const operation: PendingSave = { mutationId: crypto.randomUUID(), group, providerId: provider.id, accountId, editor: fromEditor, draft, defaultRevision: defaults.revision };
    await runSave(operation, () => fetch('/api/admin/integrations/image-generation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      channel_action: 'save-api-group', mutation_id: operation.mutationId, group, channelId: provider.id,
      apiKey: draft.apiKey, clearApiKey: draft.clearApiKey, enabled: draft.enabled, settings: draft.settings,
      models: Object.fromEntries(Object.entries(draft.models).map(([model, patch]) => {
        const { billingMode: _billingMode, fixedPoints: _fixedPoints, ...nonPricing } = (patch || {}) as typeof patch & { billingMode?: unknown; fixedPoints?: unknown };
        return [model, nonPricing];
      })),
      expectedSourceRevision: provider.sourceRevision, expectedDefaultRevision: defaults.revision,
    }) }));
  }
  async function queryReceipt() {
    const operation = pending;
    if (!operation || lock.current || !onSaveStart()) return;
    const epoch = generation.current;
    lock.current = true; activeSave.current = operation.group; setBusy(operation.group);
    let saved = false;
    try {
      const response = await fetch(`/api/admin/integrations/image-generation?group_mutation_id=${encodeURIComponent(operation.mutationId)}`, { cache: 'no-store' });
      const data = await response.json();
      if (generation.current !== epoch || account.current !== operation.accountId) return;
      if (!response.ok || data.ok !== true) throw new Error(data.error || '原回执暂不可读取。');
      if (!data.found || !data.receipt) throw new Error('尚未找到原保存回执；输入和操作编号已保留，不会重新提交。');
      applyReceipt(data.receipt, operation); saved = true; await read(true);
    } catch (error) {
      if (generation.current === epoch && account.current === operation.accountId) setMessage(current => ({ ...current, [operation.group]: error instanceof Error ? error.message : '原保存回执未确认。' }));
    } finally {
      if (generation.current === epoch && account.current === operation.accountId) {
        lock.current = false; activeSave.current = null; setBusy(null);
        const hasOther = groupHasDraft(operation.group, draftKey(operation.group, operation.providerId));
        if (saved) onDraftChange({ ...dirty, [operation.group]: hasOther }, true);
        onSaveFinish(operation.group, saved && !operation.editor && !hasOther);
      }
    }
  }
  const editorForm = forms?.find(form => form.group === editor?.group), editorProvider = editorForm?.providers.find(provider => provider.id === editor?.providerId);
  return <div>
    <p className="text-gray text-sm">型号收费在<Link href="/admin/pricing">点数与费率</Link>集中管理；这里保留供应商、Key、协议、启停与默认路由。</p>
    {readError && <div className="alert alert-error" role="alert">{readError}<button type="button" className="btn btn-secondary" disabled={Boolean(busy || pending || reading)} onClick={() => void read(Boolean(forms))}>{reading ? '正在读取' : '重新读取'}</button></div>}
    {!forms && !readError && <p role="status">正在读取图片设置</p>}
    {IMAGE_API_GROUPS.map(group => {
      const form = forms?.find(item => item.group === group), provider = form?.providers.find(item => item.id === choices[group]);
      const draft = provider && form ? drafts[draftKey(group, provider.id)] || baseDraft(form, provider) : null;
      const locked = Boolean(busy || pending || reading || needsRead || !form);
      const overrides = provider ? imageApiGroupModels(group).filter(model => provider.models[model]?.baseUrl || provider.models[model]?.apiKeyOverrideConfigured).length : 0;
      return <section key={group} aria-label={`${group === 'banana' ? 'Banana' : 'Image'}图片生成`} style={{ padding: '24px 0', borderTop: '1px solid var(--border-color)', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><h2 className="section-title">{group === 'banana' ? 'Banana' : 'Image'}</h2>
          {group === 'image' && <button type="button" className="btn btn-secondary" title="重置页面位置" aria-label="重置页面位置" onClick={() => {
            if (accountId) { try { localStorage.removeItem(`sd2-admin-image-api-position-v1:${accountId}`); } catch { /* Safe preference only. */ } }
            window.scrollTo({ top: 0, behavior: 'auto' });
          }}><RotateCcw size={16} /></button>}</div>
        <form onSubmit={event => { event.preventDefault(); void save(group); }} style={{ maxWidth: 640, minWidth: 0 }}>
          <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="form-group"><label className="form-label" htmlFor={`image-provider-${group}`}>供应商</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}><select id={`image-provider-${group}`} className="input" style={{ minWidth: 0, flex: 1 }} value={choices[group] || ''} onChange={event => setChoices(current => ({ ...current, [group]: event.target.value }))}>
                <option value="">{form?.defaultProviderId ? '选择供应商' : '原型号默认不同，请选择本组供应商'}</option>
                {form?.providers.map(item => <option key={item.id} value={item.id} disabled={item.deleted}>{item.label}{item.deleted ? '（已归档）' : ''}</option>)}
              </select><button type="button" className="btn btn-secondary" title="编辑当前供应商" aria-label="编辑当前供应商" disabled={!provider || provider.deleted} onClick={() => {
                if (provider && draft) setEditor({ group, providerId: provider.id, initial: draft });
              }}><Pencil size={16} /></button></div></div>
            <div className="form-group"><label className="form-label" htmlFor={`image-key-${group}`}>共用 API Key</label><input id={`image-key-${group}`} type="password" className="input" autoComplete="new-password" maxLength={500}
              value={draft?.apiKey || ''} placeholder={provider?.apiKeyConfigured ? '已设置，留空保留' : '输入该供应商的 API Key'} disabled={!provider || provider.deleted || draft?.clearApiKey} onChange={event => { if (provider && draft) changeDraft(group, provider.id, { ...draft, apiKey: event.target.value }); }} /></div>
            {draft?.clearApiKey && <p className="text-sm">保存会清除本组共用 Key；型号独立 Key 不变，可在编辑中取消清除。</p>}
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 12 }}><input type="checkbox" checked={draft?.enabled === true} disabled={!provider || provider.deleted} onChange={event => { if (provider && draft) changeDraft(group, provider.id, { ...draft, enabled: event.target.checked }); }} /><span>启用本组，保存后生效；不改变型号开关</span></label>
            {provider && <p className="text-gray text-sm">{provider.groupConfigured || form?.defaultProviderId === provider.id ? provider.enabled ? '已保存状态：启用' : '已保存状态：停用，可编辑并保存' : '尚未保存本组配置；启用须明确勾选'}。{overrides > 0 ? `${overrides} 个型号的独立地址或 Key 会保留。` : '各型号保留自己的协议、规格及点数。'}</p>}
            {provider && draft && form && <>
              <p className="text-gray text-sm">保存影响本组 {imageApiGroupModels(group).length} 个型号未来新任务的默认供应商，不改变模板选择的型号、另一组和已提交任务。</p>
              <ImageApiGroupModelStatuses group={group} provider={provider} draft={draft} stale={needsRead}
                showDraft={provider.id !== form.defaultProviderId || JSON.stringify(draft) !== JSON.stringify(baseDraft(form, provider))} />
            </>}
            <div className="codex-config-actions"><button type="submit" className="btn btn-primary sd2-loading-surface" data-busy={busy === group} disabled={!provider || provider.deleted || !defaults || !dirty[group]}>{busy === group ? '正在保存' : '保存'}</button></div>
          </fieldset>
          {message[group] && <p role="status" className="text-sm">{message[group]}</p>}
          {pending?.group === group && <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void queryReceipt()}>查询原保存回执</button>}
        </form>
      </section>;
    })}
    {editor && editorForm && editorProvider && <ImageApiGroupEditor group={editor.group} provider={editorProvider} draft={drafts[draftKey(editor.group, editor.providerId)] || baseDraft(editorForm, editorProvider)}
      busy={Boolean(busy || reading)} pending={Boolean(pending)} needsRead={needsRead} message={message[editor.group] || readError}
      onChange={draft => changeDraft(editor.group, editor.providerId, draft)} onDismiss={() => void dismissEditor()} onSave={() => void save(editor.group, true)} onQuery={() => void queryReceipt()} onRead={() => void read(true)} />}
    {productDialog}
  </div>;
}
