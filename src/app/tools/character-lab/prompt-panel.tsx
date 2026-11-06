'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Copy, Loader2, X } from 'lucide-react';
import { readJsonResponse } from '@/lib/http/json-response';
import { RelativeTime } from '@/components/RelativeTime';
import { CharacterLabImage } from './images';
import { characterLabMediaUrl, characterLabStrength, type CharacterLabRecipe, type CharacterLabReference } from '@/lib/character-lab/types';
import styles from './studio.module.css';

type Props = {
  ownerId: string; workspaceId: string; title: string; reference?: CharacterLabReference;
  tab: 'current' | 'next'; onTab: (tab: 'current' | 'next') => void; onClose: () => void;
  previewPayload: Record<string, unknown>; isAdmin: boolean; disabled: boolean;
  onRestore: (id: string) => Promise<boolean>; onReproduce: (id: string) => Promise<void>;
  onPreview: (reference: CharacterLabReference) => void; children: ReactNode;
  previous?: string; next?: string; onBrowse: (id: string) => void;
  escapeEnabled: boolean; onInspectSource: (id: string) => void; onPreviewAsset: (id: string) => void;
};

export function CharacterLabPromptPanel(props: Props) {
  const { ownerId, workspaceId, reference, tab, onClose } = props;
  const planId = reference?.planId;
  const [recipe, setRecipe] = useState<CharacterLabRecipe | null>(null);
  const [detailError, setDetailError] = useState('');
  const [preview, setPreview] = useState<{ revision: number; prompt: string | null; personalText: string } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [acting, setActing] = useState(false);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const signature = JSON.stringify(props.previewPayload);
  useEffect(() => {
    const controller = new AbortController();
    setRecipe(null); setDetailError(''); setFeedback('');
    if (planId) void (async () => {
      try {
        const response = await fetch(`/api/character-lab?recipe=${encodeURIComponent(planId)}`, { cache: 'no-store', signal: controller.signal });
        const value = await readJsonResponse<CharacterLabRecipe & { error?: string }>(response);
        if (!response.ok) throw new Error(value.error || '生成记录读取失败');
        if (!controller.signal.aborted) setRecipe(value);
      } catch (cause) { if (!controller.signal.aborted) setDetailError(cause instanceof Error ? cause.message : '生成记录读取失败'); }
    })();
    return () => controller.abort();
  }, [ownerId, workspaceId, planId]);
  useEffect(() => {
    if (tab !== 'next') return;
    const controller = new AbortController();
    setPreview(null); setPreviewError('');
    const timer = window.setTimeout(() => void (async () => {
      try {
        const response = await fetch('/api/character-lab', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: signature, signal: controller.signal });
        const value = await readJsonResponse<NonNullable<typeof preview> & { error?: string }>(response);
        if (!response.ok) throw new Error(value.error || '规则预览暂不可用');
        if (!controller.signal.aborted) setPreview(value);
      } catch (cause) { if (!controller.signal.aborted) setPreviewError(cause instanceof Error ? cause.message : '规则预览暂不可用'); }
    })(), 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [ownerId, workspaceId, signature, tab, previewEpoch]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setPreviewEpoch(value => value + 1); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (props.escapeEnabled && !props.disabled && event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', close, true);
    return () => document.removeEventListener('keydown', close, true);
  }, [onClose, props.escapeEnabled, props.disabled]);
  const current = recipe?.plan.id === reference?.planId ? recipe : null;
  const currentText = current?.completePrompt ?? current?.instruction ?? current?.personalText;
  async function act(action: () => Promise<void>) {
    setActing(true); setFeedback('');
    try { await action(); } catch (cause) { setFeedback(cause instanceof Error ? cause.message : '操作未完成，输入保留'); }
    finally { setActing(false); }
  }
  return <aside id="character-recipe-panel" className={styles.recipePanel} aria-label={`${props.title}提示词`}>
    <header><h2>{props.title}提示词</h2><button type="button" className={styles.iconButton} aria-label="关闭提示词面板" onClick={onClose}><X size={18} /></button></header>
    <div className={styles.segmented} role="group" aria-label="提示词用途">
      <button type="button" aria-pressed={tab === 'current'} onClick={() => props.onTab('current')}>当前图片</button>
      <button type="button" aria-pressed={tab === 'next'} onClick={() => props.onTab('next')}>下次生成</button>
    </div>
    <div className={styles.recipeBody}>
      {tab === 'current' && (props.previous || props.next) && <div className={styles.recipeActions}>
        <button type="button" disabled={!props.previous || props.disabled || acting} onClick={() => props.previous && props.onBrowse(props.previous)}>上一组</button>
        <button type="button" disabled={!props.next || props.disabled || acting} onClick={() => props.next && props.onBrowse(props.next)}>下一组</button>
      </div>}
      {tab === 'current' ? !reference ? <p className={styles.hint}>当前区域还没有可查看的图片。下次生成里可编辑本次要求。</p>
        : detailError ? <p role="status">{detailError}</p> : !current ? <p role="status"><Loader2 size={14} className="animate-spin" />正在读取这张图片的生成记录…</p> : <>
          <div className={styles.recipeIdentity}>
            {current.hasImage && <button type="button" onClick={() => props.onPreview(reference)} aria-label="放大当前记录图片"><CharacterLabImage src={characterLabMediaUrl(reference.planId, reference.cell)} alt="当前生成记录图片" /></button>}
            <span><strong>{current.plan.operation === 'body-pair' ? '正背面同次生成' : current.plan.kind === 'faces' ? `${current.plan.count}宫格${reference.cell !== undefined ? ` · 第${reference.cell + 1}格` : ''}` : '角色生成记录'}</strong><RelativeTime value={current.plan.createdAt} /><small>记录 {current.plan.id.slice(0, 8)}</small></span>
          </div>
          <dl className={styles.recipeFacts}>
            <div><dt>模型</dt><dd>{current.plan.model}</dd></div><div><dt>画质 / 分辨率</dt><dd>{current.plan.quality} / {current.plan.resolution}</dd></div>
            <div><dt>规则版本</dt><dd>v{current.plan.configRevision}</dd></div><div><dt>比例</dt><dd>{current.plan.aspectRatio}</dd></div>
            <div><dt>渠道</dt><dd>{current.plan.channelId}</dd></div>
            {current.plan.kind === 'faces' && !current.plan.operation && <div><dt>面部变化</dt><dd>{characterLabStrength(current.plan.diversity)}</dd></div>}
          </dl>
          <label className={styles.field}><span>本次补充要求</span><textarea readOnly rows={3} value={current.personalText || '本次没有补充要求'} /></label>
          {props.isAdmin && <details className={styles.recipeDetail}><summary>{current.completePrompt !== null ? '实际生效的完整提示词' : '待生成的规则预览'}</summary>
            <pre>{current.completePrompt ?? current.instruction}</pre>
            {!current.completePrompt && <p className={styles.hint}>该计划尚无已受理任务，不能作为已发送记录。</p>}
          </details>}
          <details className={styles.recipeDetail}><summary>参考图与来源 · {current.references.length}张</summary>
            <div className={styles.recipeReferences}>{current.references.map(item => <div key={item.id}>
              {item.available && <button type="button" aria-label={'放大' + item.label} onClick={() => item.source ? props.onPreview(item.source) : props.onPreviewAsset(item.id)}><CharacterLabImage src={item.source ? characterLabMediaUrl(item.source.planId, item.source.cell) : `/api/image-studio/template-assets/${encodeURIComponent(item.id)}`} alt={item.label} /></button>}
              <span>{item.label}{!item.available && ' · 当前不可用'}{item.source && <small>来源 {item.source.planId.slice(0, 8)}{item.source.cell !== undefined ? ` · 第${item.source.cell + 1}格` : ''}<button type="button" onClick={() => props.onInspectSource(item.source!.planId)}>查看来源提示词</button></small>}</span>
            </div>)}</div>
            {current.plan.origin && <p className={styles.hint}>{current.plan.origin.mode === 'historical' ? '按原设置重新生成' : '沿用设置继续创作'}<button type="button" onClick={() => props.onInspectSource(current.plan.origin!.planId)}>查看来源记录</button></p>}
          </details>
          <div className={styles.recipeActions}>
            <button type="button" disabled={acting || !currentText} onClick={() => void act(async () => { await navigator.clipboard.writeText(currentText || ''); setFeedback('已复制可见提示词'); })}><Copy size={14} />复制提示词</button>
            <button type="button" className={styles.outline} disabled={acting || props.disabled} onClick={() => void act(async () => { if (await props.onRestore(current.plan.id)) props.onTab('next'); })}>沿用设置</button>
            <details><summary>更多</summary><button type="button" disabled={acting || props.disabled || current.plan.operation === 'body-front' || current.plan.operation === 'body-back'} onClick={() => void act(() => props.onReproduce(current.plan.id))}>按原设置重新生成</button></details>
          </div>
          {feedback && <p className={styles.hint} role="status">{feedback}</p>}
        </> : <>
          {props.children}
          {props.isAdmin && <details className={styles.recipeDetail}><summary>服务器规则预览{preview ? ` · v${preview.revision}` : ''}</summary>
            {previewError ? <p role="status">{previewError}</p> : preview ? <pre>{preview.prompt}</pre> : <p role="status">正在读取当前已保存规则…</p>}
            <p className={styles.hint}>生成时以确认报价的冻结输入为准，生成后可查看完整参考说明。</p>
          </details>}
        </>}
    </div>
  </aside>;
}
