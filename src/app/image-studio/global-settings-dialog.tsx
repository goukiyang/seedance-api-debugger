'use client';

import { useProductDialog } from '@/components/useProductDialog';
import { ContextClipboardActions } from '@/components/ContextClipboardActions';
import { GenerationCompletionSettings } from '@/components/GenerationCompletion';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { RefreshCw, Save, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_NEW_REQUEST_MODELS, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS,
  IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, IMAGE_STUDIO_QUALITY_LABELS, defaultImageResolution, defaultImageStudioQuality,
  imageStudioNewQualityOptions, imageStudioQualityLabel, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import type { StudioTemplateDefaults } from '@/lib/image-studio/template-defaults';
import { RatioPicker } from './ratio-picker';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import type { useStudioSettings } from './use-studio-settings';
import styles from './studio.module.css';
import { useResolutionApply } from './use-resolution-apply';
import { ResolutionApplyPanel } from './resolution-apply-panel';
import type { ResolutionDelta } from '@/lib/image-studio/resolution-apply-types';
import { PrivateDefinitionEditor } from './PrivateDefinitionEditor';

export function StudioGlobalSettingsDialog({ open, onClose, editor, ownerId, canEdit, ratios, getExcluded, onDeltas }: {
  open: boolean; onClose: () => void; editor: ReturnType<typeof useStudioSettings>; ownerId: string; canEdit: boolean;
  ratios: Pick<ComponentProps<typeof RatioPicker>, 'custom' | 'busy' | 'error' | 'onRetry' | 'onCustom'>;
  getExcluded: () => string[]; onDeltas: (deltas: ResolutionDelta[]) => void;
}) {
  const { confirm, productDialog } = useProductDialog();
  const dialog = useRef<HTMLDialogElement>(null);
  const contextInput = useRef<HTMLTextAreaElement>(null);
  const saveLock = useRef(false);
  const beforePrivateClose = useRef<(() => Promise<boolean>) | null>(null);
  const [ratioEditing, setRatioEditing] = useState(false);
  const batch = useResolutionApply({ open, ownerId, canEdit, editor, getExcluded, onDeltas });
  const defaults = editor.draft?.templateDefaults;
  const selectedModelReady = defaults
    ? editor.settings?.modelReady?.[defaults.model] ?? editor.settings?.providerReady
    : undefined;
  usePageExitRisk({ unsaved: ratioEditing ? ['图片默认比例'] : [],
    busy: open && (ratios.busy || batch.writing) ? ['图片设置正在保存或应用'] : [], revision: String(ratioEditing) });
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      if (!editor.controller.getSnapshot().settings) void editor.controller.load();
    }
    else dialog.current?.close();
  }, [open, editor.controller]);
  const close = async () => {
    if (canEdit && (editor.saving || ratios.busy || batch.writing)) return;
    if (canEdit && ratioEditing && !(await confirm('比例编辑尚未完成，关闭会丢失这部分输入。确定关闭吗？', { title: '关闭编辑', confirmLabel: '关闭编辑' }))) return;
    if (beforePrivateClose.current && !await beforePrivateClose.current()) return;
    onClose();
  };
  useDialogDismiss({ open, dialogRef: dialog, nativeDialog: true, onDismiss: close });
  const reload = async () => {
    if (!canEdit || editor.loading || editor.saving || batch.writing) return;
    if (!editor.dirty || (await confirm('重新读取会替换未保存的通用设置，是否继续？', { title: '重新读取', confirmLabel: '放弃修改并读取' }))) void editor.controller.load(true);
  };
  const save = async () => {
    if (!canEdit || saveLock.current || editor.saving || editor.loading || editor.conflicts.length || ratios.busy || ratioEditing || batch.writing || batch.scope && batch.busy) return;
    saveLock.current = true;
    try {
      if (beforePrivateClose.current && !await beforePrivateClose.current()) return;
      if (editor.settings?.context?.trim() && editor.draft && !editor.draft.context.trim()
        && !(await confirm('确定清空通用上下文？这会影响所有模板之后的新生成，模板自己的上下文会保留。', { title: '清空上下文', confirmLabel: '清空并保存', danger: true }))) return;
      if (batch.scope) {
        if (!batch.canCommit || !batch.value) return;
        const count = batch.value.operation.counts.change;
        if (!(await confirm(`保存通用设置，并把我的 ${count} 个已有模板分辨率改为 ${batch.value.operation.resolution}？其它模板参数和共享原模板不会改变。`, { title: '应用分辨率', confirmLabel: '保存并应用' }))) return;
        if (await batch.commit()) onClose();
      } else if (await editor.controller.save()) onClose();
    } finally { saveLock.current = false; }
  };
  const conflictFields = (prefix: string) => editor.conflicts.filter(item => item.field === prefix || item.field.startsWith(`${prefix}.`)).map(item => {
    const fieldLabels: Record<string, string> = { context: '通用上下文', model: '生成模型', quality: '图片质量', resolution: '分辨率', count: '生成张数',
      aspectRatio: '图片比例', primaryMin: '主图最少张数', primaryMax: '主图最多张数', auxiliaryMax: '辅助总上限', styleMax: '风格上限', referenceMax: '参考上限', useFixedReferences: '模板固定参考图' };
    const key = item.field.slice(item.field.indexOf('.') + 1);
    const label = fieldLabels[key] || IMAGE_STUDIO_MODEL_LABELS[key as ImageStudioModel] || key;
    return <div key={item.field} role="status" className={styles.error}>
      <span>{label}已在其他页面更新，你的修改已保留。</span>
      <details><summary>查看已保存值</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(item.saved ?? '未设置')}</p></details>
      <button type="button" disabled={editor.saving || batch.writing} onClick={() => editor.controller.resolveConflict(item.field, 'draft')}>保留我的修改</button>
      <button type="button" disabled={editor.saving || batch.writing} onClick={() => editor.controller.resolveConflict(item.field, 'saved')}>采用已保存值</button>
    </div>;
  });
  return <>{productDialog}{(<dialog ref={dialog} className={`${styles.dialog} ${styles.contextDialog}`}>
    <header className={styles.header}><h2>通用设置</h2><button type="button" aria-label="关闭设置" onClick={close}><X size={20} /></button></header>
    {open && <GenerationCompletionSettings key={ownerId} ownerId={ownerId} />}
    {canEdit && <>{editor.draft && defaults && <>
      {editor.settings?.privateContext ? <PrivateDefinitionEditor key={ownerId} userId={ownerId} moduleId="gpt_image_studio_v1"
        dialog={dialog} beforeClose={beforePrivateClose} blocked={!open} contextOnly label="通用上下文"
        endpoint="/api/image-studio/settings" canRead={editor.settings.canReadPrivatePrompt === true}
        needsIdentity={editor.settings.requiresIdentityVerification === true} onSaved={(_, keepEditing) => {
          void editor.controller.load();
          if (!keepEditing) onClose();
        }} /> : <>
      <label className={styles.label} htmlFor="studio-context">通用上下文</label>
      <ContextClipboardActions value={editor.draft.context} textareaRef={contextInput} onPaste={value => { if (canEdit) editor.controller.editContext(value); }} maxLength={20000} disabled={!canEdit || editor.loading || editor.saving || !open} />
      <textarea ref={contextInput} id="studio-context" rows={12} maxLength={20000} disabled={!canEdit || editor.loading}
        value={editor.draft.context} onChange={event => { if (canEdit) editor.controller.editContext(event.target.value); }} />
      {conflictFields('context')}
      </>}
      <section className={styles.auxiliarySection} aria-labelledby="studio-template-defaults-title">
        <div className={styles.imageSectionHeading}><strong id="studio-template-defaults-title">模板统一默认值</strong></div>
        <p className={styles.muted}>统一默认值用于新建模板。</p>
        <div className={styles.referenceLimits}>
          <div className={styles.primaryRange} role="group" aria-label="默认主图张数范围"><span>主图</span>
            <select aria-label="主图最少张数" value={defaults.primaryMin} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ primaryMin: Number(event.target.value) })}>
              {Array.from({ length: defaults.primaryMax + 1 }, (_, value) => <option key={value} value={value}>{value}</option>)}
            </select><span aria-hidden="true">-</span>
            <select aria-label="主图最多张数" value={defaults.primaryMax} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ primaryMax: Number(event.target.value) })}>
              {Array.from({ length: MAX_REFERENCE_IMAGES - defaults.primaryMin + 1 }, (_, index) => {
                const value = defaults.primaryMin + index;
                return value > 0 ? <option key={value} value={value}>{value}</option> : null;
              })}
            </select><span>张</span>
          </div>
          {([
            ['styleMax', '风格上限'], ['referenceMax', '参考上限'], ['auxiliaryMax', '辅助总上限'],
          ] as const).map(([key, label]) => <label key={key}>{label}
            <select aria-label={`${label}张数`} value={defaults[key]} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ [key]: Number(event.target.value) } as Partial<StudioTemplateDefaults>)}>
              {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>{value} 张</option>)}
            </select>
          </label>)}
        </div>
        <div className={styles.modelQualityRow}>
          <label className={styles.compactField}><strong>生成模型</strong>
            <select value={defaults.model} disabled={!canEdit || editor.loading} onChange={event => {
              const model = event.target.value as ImageStudioModel;
              const replacesLegacyBanana = defaults.model === 'gemini-3.1-flash-image-preview' && model === 'gemini-nano-banana-2.1';
              editor.controller.editTemplateDefaults(replacesLegacyBanana ? { model }
                : { model, quality: defaultImageStudioQuality(model), resolution: defaultImageResolution(model) });
            }}>
              {defaults.model === 'gemini-3.1-flash-image-preview' && <option value={defaults.model} disabled>{IMAGE_STUDIO_MODEL_LABELS[defaults.model]}</option>}
              {IMAGE_STUDIO_NEW_REQUEST_MODELS.map(model => {
                const ready = editor.settings?.modelReady?.[model] ?? editor.settings?.providerReady;
                return <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model]}{ready === false ? '（服务未就绪）' : ''}</option>;
              })}
            </select>
          </label>
          <label className={styles.compactField}><strong>图片质量</strong>
            <select value={defaults.quality} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ quality: event.target.value as typeof defaults.quality })}>
              {!imageStudioNewQualityOptions(defaults.model).includes(defaults.quality) && <option value={defaults.quality} disabled>原质量待选择</option>}
              {imageStudioNewQualityOptions(defaults.model).map(option => <option key={option} value={option}>{imageStudioQualityLabel(defaults.model, option)}</option>)}
            </select>
          </label>
          <label className={styles.compactField}><strong>分辨率</strong>
            <select value={defaults.resolution} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ resolution: event.target.value as typeof defaults.resolution })}>
              {IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[defaults.model].map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        </div>
        <fieldset className={styles.resolutionScope}><legend>分辨率适用范围</legend>
          <label><input type="radio" name="studio-resolution-scope" checked={!batch.scope} disabled={batch.busy} onChange={() => batch.setScope(false)} />仅新建模板</label>
          <label><input type="radio" name="studio-resolution-scope" checked={batch.scope} disabled={batch.busy} onChange={() => batch.setScope(true)} />新建模板 + 我的已有模板</label>
        </fieldset>
        <button type="button" disabled={batch.busy} onClick={() => void batch.loadHistory()}>{batch.historyRequested ? '重新读取分辨率操作记录' : '查看分辨率操作记录'}</button>
        <ResolutionApplyPanel batch={batch} onContinue={() => { void (async () => { if (await batch.continue()) onClose(); })(); }} onRestore={() => { void batch.restore(); }} />
        <div className={styles.modelQualityRow}>
          <label className={styles.compactField}><strong>生成张数</strong>
            <select value={defaults.count} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ count: Number(event.target.value) })}>
              {Array.from({ length: 8 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <RatioPicker value={defaults.aspectRatio} onChange={aspectRatio => editor.controller.editTemplateDefaults({ aspectRatio })}
            model={defaults.model} resolution={defaults.resolution}
            {...ratios} disabled={!canEdit || editor.loading || editor.saving || !open} onEditing={setRatioEditing} />
          <label className={styles.referenceToggle}>
            <input type="checkbox" checked={defaults.useFixedReferences} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ useFixedReferences: event.target.checked })} />使用模板固定参考图
          </label>
        </div>
        {selectedModelReady === false && <p className={styles.muted}>所选模型的图片服务当前未就绪；这里仍可保存默认值，服务就绪后再使用。</p>}
        {conflictFields('templateDefaults')}
      </section>
      <p className={styles.label}>通用模型积分规则</p>
      {IMAGE_STUDIO_MODELS.map(model => <label className={styles.label} key={model}>{IMAGE_STUDIO_MODEL_LABELS[model]} 每张积分
        <input type="number" min={0} max={100000} step={1} disabled={!canEdit || editor.loading}
          placeholder={model === 'gemini-3-pro-image-preview' ? '未设置' : '20'} value={editor.draft?.prices[model] ?? ''}
          onChange={event => { if (canEdit) editor.controller.editPrice(model, event.target.value === '' ? null : Number(event.target.value)); }} />
      </label>)}
      {conflictFields('prices')}
      <button type="button" className={styles.primary} disabled={!canEdit || editor.conflicts.length > 0 || (batch.scope ? !batch.canCommit || batch.busy : !editor.dirty) || editor.loading || editor.saving || batch.writing || ratios.busy || ratioEditing} onClick={save}><Save size={16} />{editor.saving || batch.writing ? '正在保存或应用' : batch.scope ? '保存并应用分辨率' : '保存设置'}</button>
    </>}
    <p role="status">{editor.status || '正在读取通用设置'}</p>
    {editor.error && <div role="alert" className={styles.error}>{editor.error}
      <button type="button" disabled={!canEdit || editor.loading || editor.saving} onClick={reload}><RefreshCw size={16} />重新读取</button>
    </div>}</>}
  </dialog>)}</>;
}
