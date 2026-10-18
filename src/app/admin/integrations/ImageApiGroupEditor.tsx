'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from '@/components/ProductDialog.module.css';
import { IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { STUDIO_RATIOS } from '@/lib/image-studio/ratios';
import { imageApiGroupModels, imageApiGroupModelMissingRequirements, type ImageApiGroup, type ImageApiGroupSettings, type ImageApiGroupProviderDto, type ImageApiGroupModelDto } from '@/lib/integrations/image-generation-channel';

type ModelPatch = Partial<Pick<ImageApiGroupModelDto, 'enabled' | 'protocol' | 'upstreamModel' | 'baseUrl' | 'qualities' | 'resolutions' | 'ratios' | 'maxReferences'>> & { apiKey?: string; clearApiKey?: boolean };
type EditableGroupSettings = Pick<ImageApiGroupSettings, 'label' | 'supplierName' | 'provider' | 'baseUrl'>;
export type ImageApiGroupDraft = { apiKey: string; clearApiKey: boolean; enabled: boolean; settings: Partial<EditableGroupSettings>; models: Partial<Record<ImageStudioModel, ModelPatch>> };
type Props = {
  group: ImageApiGroup; provider: ImageApiGroupProviderDto; draft: ImageApiGroupDraft;
  busy: boolean; pending: boolean; needsRead: boolean; message: string;
  onChange: (draft: ImageApiGroupDraft) => void; onDismiss: () => void; onSave: () => void; onQuery: () => void; onRead: () => void;
};

function draftModelStatus(group: ImageApiGroup, provider: ImageApiGroupProviderDto, draft: ImageApiGroupDraft, model: ImageStudioModel) {
  const current = provider.models[model], patch = draft.models[model] || {}, value = { ...current, ...patch };
  const settings = { ...provider.settings, ...draft.settings };
  const hasModelPatch = Object.keys(patch).length > 0;
  const baseUrl = (value.baseUrl || settings.baseUrl).trim();
  const ownKey = patch.clearApiKey !== true && Boolean(patch.apiKey?.trim() || current?.apiKeyOverrideConfigured);
  const commonKey = !draft.clearApiKey && Boolean(draft.apiKey.trim() || provider.apiKeyConfigured);
  const extra: string[] = [], actualBillingReasons: string[] = [];
  if (baseUrl) {
    try { if (!['https:', 'http:'].includes(new URL(baseUrl).protocol)) extra.push('API 地址格式无效'); }
    catch { extra.push('API 地址格式无效'); }
  }
  if (typeof value.maxReferences === 'number' && value.maxReferences > MAX_REFERENCE_IMAGES) extra.push(`参考图上限不能超过 ${MAX_REFERENCE_IMAGES}`);
  for (const key of [draft.apiKey, patch.apiKey || '']) {
    if (key.trim() && (/[*•●…]{3,}/.test(key) || /[\r\n\x00-\x1f\x7f]/.test(key))) extra.push('API Key 不能使用掩码或控制字符');
  }
  if (value.billingMode === 'actual') {
    const upstreamModel = value.upstreamModel?.trim() || model;
    if (upstreamModel !== model) actualBillingReasons.push('上游型号与本站型号不同，尚无对应的精确账单证明');
    if (settings.provider !== 'musk') actualBillingReasons.push('实际计费仅适用于已确认的 Musk 供应商与同一 API Key');
    const scopeChanged = settings.provider !== provider.settings.provider
      || baseUrl !== (current?.baseUrl || provider.settings.baseUrl).trim()
      || Boolean(patch.apiKey?.trim()) || patch.clearApiKey === true
      || !ownKey && Boolean(draft.apiKey.trim() || draft.clearApiKey)
      || upstreamModel !== (current?.upstreamModel || model)
      || value.protocol !== current?.protocol || value.billingMode !== current?.billingMode;
    if (scopeChanged || current?.actualQuoteRequired !== true) actualBillingReasons.push('精确账单证明需保存后由服务端核对');
  }
  const missingRequirements = imageApiGroupModelMissingRequirements({
    providerSupported: settings.provider !== 'seedream', baseUrlConfigured: Boolean(baseUrl), apiKeyConfigured: ownKey || commonKey,
    protocol: !hasModelPatch && current?.protocolConfigured !== true ? null : value.protocol || (group === 'banana' ? 'gemini_native' : 'openai_images'),
    qualities: value.qualities, resolutions: value.resolutions, ratios: value.ratios,
    maxReferences: value.maxReferences, billingMode: value.billingMode, fixedPoints: value.fixedPoints,
  }, actualBillingReasons);
  missingRequirements.push(...extra.filter(reason => !missingRequirements.includes(reason)));
  const blockingReasons: string[] = [];
  if (provider.deleted) blockingReasons.push('该供应商已归档');
  if (!draft.enabled) blockingReasons.push('本次输入未启用本组');
  if (value.enabled !== true) blockingReasons.push('该型号未启用');
  return { enabled: value.enabled === true, configurationReady: missingRequirements.length === 0, missingRequirements, blockingReasons };
}

export function ImageApiGroupModelStatuses({ group, provider, draft, showDraft = false, stale = false }: {
  group: ImageApiGroup; provider: ImageApiGroupProviderDto; draft: ImageApiGroupDraft; showDraft?: boolean; stale?: boolean;
}) {
  const requirements = (items: string[], label: string) => items.length > 0 && <ul aria-label={label} className="text-sm" style={{ paddingLeft: 20, margin: '4px 0', color: 'var(--tone-warning-text)' }}>
    {items.map(item => <li key={item} style={{ overflowWrap: 'anywhere' }}>{item}</li>)}
  </ul>;
  return <div style={{ margin: '12px 0', minWidth: 0 }}>
    <p className="text-gray text-sm">{provider.groupConfigured ? '已保存的本组型号状态' : '供应商原有型号配置（本组独立配置未保存）'}{stale ? '，最新状态待重新读取' : ''}。连通性和实际出图未验证。</p>
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {imageApiGroupModels(group).map(model => {
        const saved = provider.models[model], preview = showDraft ? draftModelStatus(group, provider, draft, model) : null;
        const known = typeof saved?.configurationReady === 'boolean' && Array.isArray(saved.missingRequirements) && Array.isArray(saved.blockingReasons);
        return <li key={model} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-color)', overflowWrap: 'anywhere' }}>
          <span className="text-sm">{IMAGE_STUDIO_MODEL_LABELS[model]}</span>
          <p className="text-gray text-sm" style={{ marginTop: 4 }}>已保存：{typeof saved?.enabled === 'boolean' ? `型号${saved.enabled ? '启用' : '停用'}` : '型号开关未读取'}；{known && saved
            ? saved.configurationReady ? saved.ready ? '配置齐备，新任务配置可用' : '配置齐备，新任务暂不可用' : '配置未齐'
            : '完整状态未读取，请重新读取核对'}。</p>
          {known && saved && <>
            {saved.blockingReasons!.length > 0 && <p className="text-gray text-sm">{saved.blockingReasons!.join('；')}</p>}
            {requirements(saved.missingRequirements!, '已保存配置缺项')}
          </>}
          {preview && <div style={{ marginTop: 8 }}>
            <p className="text-gray text-sm">本次输入（未保存）：型号{preview.enabled ? '启用' : '停用'}；{preview.configurationReady ? '本地可判条件已齐，保存后由服务端核对' : '配置未齐'}。</p>
            {preview.blockingReasons.length > 0 && <p className="text-gray text-sm">{preview.blockingReasons.join('；')}</p>}
            {requirements(preview.missingRequirements, '本次输入缺项')}
          </div>}
        </li>;
      })}
    </ul>
  </div>;
}

export default function ImageApiGroupEditor({ group, provider, draft, busy, pending, needsRead, message, onChange, onDismiss, onSave, onQuery, onRead }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), scopeId = useId();
  const settings = { ...provider.settings, ...draft.settings };
  const locked = busy || pending || needsRead || provider.deleted;
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, onDismiss: () => { if (!busy) onDismiss(); } });
  useEffect(() => { dialog.current?.showModal(); }, []);
  const shared = <K extends keyof EditableGroupSettings>(field: K, value: EditableGroupSettings[K]) => onChange({ ...draft, settings: { ...draft.settings, [field]: value } });
  const modelChange = (model: ImageStudioModel, patch: ModelPatch) => onChange({ ...draft, models: { ...draft.models, [model]: { ...draft.models[model], ...patch } } });
  const field = (label: string, content: ReactNode) => <label className="form-group" style={{ display: 'block', minWidth: 0 }}><span className="form-label">{label}</span>{content}</label>;
  const retained = (label: string, value: string | number | boolean) => <div style={{ minWidth: 0 }}><dt className="form-label">{label}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{typeof value === 'boolean' ? value ? '是' : '否' : String(value)}</dd></div>;
  return createPortal(<dialog ref={dialog} className={styles.dialog} style={{ width: 'min(760px, calc(100vw - 32px))' }} aria-modal="true" aria-labelledby={titleId} aria-describedby={scopeId}>
    <form onSubmit={event => { event.preventDefault(); onSave(); }} aria-busy={busy}>
      <header className={styles.header}><h2 id={titleId}>{group === 'banana' ? 'Banana' : 'Image'} 设置</h2>
        <button type="button" className={styles.close} aria-label="关闭设置" title="关闭设置" disabled={busy} onClick={onDismiss}><X size={18} /></button></header>
      <p id={scopeId} className={styles.message}>保存影响本组 {imageApiGroupModels(group).length} 个型号未来未另选供应商的新任务默认，不改变模板选择的型号、另一组和已提交任务。型号独立地址和 Key 默认保留，原供应商公共开关不变。</p>
      <ImageApiGroupModelStatuses group={group} provider={provider} draft={draft} showDraft stale={needsRead} />
      <fieldset disabled={locked} style={{ border: 0, padding: 0, minWidth: 0 }}>
        {field('配置名称', <input className={styles.input} maxLength={120} value={settings.label} onChange={event => shared('label', event.target.value)} />)}
        {field('供应商名称', <input className={styles.input} maxLength={120} value={settings.supplierName} onChange={event => shared('supplierName', event.target.value)} />)}
        {field('接口类型（仅本组）', <select className={styles.input} value={settings.provider} disabled={provider.id === 'fluxport'} onChange={event => shared('provider', event.target.value as ImageApiGroupSettings['provider'])}>
          {provider.id === 'fluxport' ? <option value="fluxport">FluxPort</option> : <><option value="musk">MuskAPI</option><option value="ai_media_vip">AI Media VIP</option><option value="managed">自定义供应商</option><option value="seedream">Seedream（尚未支持本组型号）</option></>}
        </select>)}
        {field('API 地址', <input className={styles.input} type="url" maxLength={2048} value={settings.baseUrl} placeholder="https://" onChange={event => shared('baseUrl', event.target.value)} />)}
        {field('共用 API Key', <input className={styles.input} type="password" autoComplete="new-password" maxLength={500} value={draft.apiKey} disabled={draft.clearApiKey} placeholder={provider.apiKeyConfigured ? '已设置，留空保留' : '尚未设置'} onChange={event => onChange({ ...draft, apiKey: event.target.value })} />)}
        <label className={styles.checkbox}><input type="checkbox" checked={draft.clearApiKey} onChange={event => onChange({ ...draft, clearApiKey: event.target.checked, apiKey: '' })} />清除本组共用 Key；型号独立 Key 不变</label>
        <label className={styles.checkbox}><input type="checkbox" checked={draft.enabled} onChange={event => onChange({ ...draft, enabled: event.target.checked })} />启用本组，保存后生效；不改变下方各型号的开关</label>
        <details style={{ margin: '18px 0' }}><summary>原参数（只读）</summary>
          <p className={styles.message}>当前 Image/Banana 普通生图每任务 1 张，输出 PNG，请求超时 300000ms（5 分钟）。以下为原配置留存，不改变本组实际出图参数。</p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
            {retained('原默认型号', provider.settings.defaultModel)}
            {retained('原超时（毫秒）', provider.settings.timeoutMs)}
            {retained('原单次图片上限', provider.settings.maxOutputs)}
            {retained('原默认比例', provider.settings.defaultRatio)}
            {retained('原默认尺寸', provider.settings.defaultSize)}
            {retained('原图片格式', provider.settings.outputFormat)}
            {retained('原返回格式', provider.settings.responseFormat)}
            {retained('原水印标记', provider.settings.watermark)}
            {retained('原文字生图标记', provider.settings.supportsTextToImage)}
            {retained('原参考图标记', provider.settings.supportsImageToImage)}
            {retained('原异步标记', provider.settings.supportsAsyncTask)}
          </dl>
          <p className={styles.message}>实际型号、质量、尺寸和比例以任务选择为准；允许规格、请求协议及上游型号由下方各型号配置决定。共用能力标记不决定本组普通生图和异步提交，其他已有入口仍沿用原逻辑。</p>
        </details>
        {imageApiGroupModels(group).map(model => {
          const current = provider.models[model], patch = draft.models[model] || {}, value = { ...current, ...patch };
          const prefix = `${group}-${model}`;
          return <details key={model} style={{ borderTop: '1px solid var(--border-color)', padding: '14px 0' }}>
            <summary>{IMAGE_STUDIO_MODEL_LABELS[model]}{value.enabled ? '' : '（型号停用）'}</summary>
            <p className={styles.message}>{model}</p>
            <label className={styles.checkbox}><input type="checkbox" checked={value.enabled === true} onChange={event => modelChange(model, { enabled: event.target.checked })} />允许此型号生成新任务</label>
            {field('请求协议', <select className={styles.input} value={value.protocol || (group === 'banana' ? 'gemini_native' : 'openai_images')} onChange={event => modelChange(model, { protocol: event.target.value as 'gemini_native' | 'openai_images' })}><option value="openai_images">OpenAI Images</option><option value="gemini_native">Gemini 原生</option></select>)}
            {field('上游型号', <input className={styles.input} maxLength={200} value={value.upstreamModel || ''} placeholder={`留空使用 ${model}`} onChange={event => modelChange(model, { upstreamModel: event.target.value })} />)}
            {field('独立 API 地址', <input className={styles.input} type="url" maxLength={2048} value={value.baseUrl || ''} placeholder="留空继承共用地址" onChange={event => modelChange(model, { baseUrl: event.target.value })} />)}
            {field('独立 API Key', <input className={styles.input} type="password" autoComplete="new-password" maxLength={500} value={patch.apiKey || ''} disabled={patch.clearApiKey === true} placeholder={current?.apiKeyOverrideConfigured ? '已有独立 Key，留空保留' : '未覆写，继承共用 Key'} onChange={event => modelChange(model, { apiKey: event.target.value })} />)}
            <label className={styles.checkbox}><input type="checkbox" checked={patch.clearApiKey === true} onChange={event => modelChange(model, { clearApiKey: event.target.checked, apiKey: '' })} />移除此型号的独立 Key，改为继承共用 Key</label>
            {(['qualities', 'resolutions', 'ratios'] as const).map(kind => {
              const options = kind === 'qualities' ? IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model] : kind === 'resolutions' ? IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model] : ['auto', ...STUDIO_RATIOS];
              return <fieldset key={kind} style={{ border: 0, padding: '8px 0', minWidth: 0 }}><legend className="form-label">{kind === 'qualities' ? '已确认质量' : kind === 'resolutions' ? '已确认分辨率' : '已确认比例'}</legend>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px' }}>{options.map(option => <label key={option} className={styles.checkbox} htmlFor={`${prefix}-${kind}-${option}`}>
                  <input id={`${prefix}-${kind}-${option}`} type="checkbox" checked={value[kind]?.includes(option) === true} onChange={event => modelChange(model, { [kind]: event.target.checked ? [...(value[kind] || []), option] : (value[kind] || []).filter(item => item !== option) })} />{option === 'auto' ? '自动' : option}</label>)}</div>
                {!value[kind]?.length && <span className="text-gray text-sm">未确认，不自动填写</span>}
              </fieldset>;
            })}
            {field('参考图上限', <input className={styles.input} type="number" min={0} max={MAX_REFERENCE_IMAGES} step={1} value={value.maxReferences ?? ''} placeholder="未确认" onChange={event => modelChange(model, { maxReferences: event.target.value === '' ? null : Number(event.target.value) })} />)}
            <div className={styles.message}>收费统一在<Link href={`/admin/pricing?channelId=${encodeURIComponent(provider.channelId || provider.id)}&search=${encodeURIComponent(model)}`}>点数与费率</Link>查看和修改。此处保存不改费率。</div>
            <details><summary>旧收费配置留存（只读）</summary><p className={styles.message}>{current?.billingMode === 'actual' ? '原实际费用合同' : current?.billingMode === 'fixed' ? `原固定点数：${current.fixedPoints ?? '未确认'}` : '原计费方式未确认'}，不代表当前策略的新任务价格。</p></details>
          </details>;
        })}
      </fieldset>
      {message && <p role="status" className={styles.message}>{message}</p>}
      <footer className={styles.actions}>
        {needsRead && !pending && <button type="button" className={styles.secondary} disabled={busy} onClick={onRead}>重新读取</button>}
        {pending && <button type="button" className={styles.primary} disabled={busy} onClick={onQuery}>查询原保存回执</button>}
        <button type="button" className={styles.secondary} disabled={busy} onClick={onDismiss}>取消</button>
        <button type="submit" className={styles.primary} disabled={locked}>{busy ? '正在保存' : '保存'}</button>
      </footer>
    </form>
  </dialog>, document.body);
}
