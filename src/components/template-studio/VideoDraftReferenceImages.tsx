'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Info, RotateCw } from 'lucide-react';
import { StudioReferenceGrid } from '@/app/image-studio/reference-grid';
import MediaPreview from '@/components/MediaPreview';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import type { UploadedAssetPayload } from '@/lib/http/file-upload';
import type { StudioAssetInput, StudioDraftDto } from '@/lib/template-studio/types';
import styles from './template-studio.module.css';

type ReferenceImage = UploadedAssetPayload & { id: string };
type Props = {
  userId: string;
  draft: StudioDraftDto;
  busy: boolean;
  onAdd: (slotKey: string | null) => void;
  onChange: (ids: string[]) => void;
  onBind: (index: number, slotKey: string) => void;
  onRole: (index: number, role: StudioAssetInput['role']) => void;
};

export default function VideoDraftReferenceImages({ userId, draft, busy, onAdd, onChange, onBind, onRole }: Props) {
  const images = draft.assets.filter(asset => asset.type === 'image');
  const slots = draft.recipe?.assetSlots || [];
  const lookupKey = JSON.stringify(images.map(asset => asset.assetId).sort());
  const lookupIds = useMemo(() => JSON.parse(lookupKey) as string[], [lookupKey]);
  const scope = JSON.stringify([userId, draft.id, lookupKey]);
  const draftId = draft.id;
  const [metadata, setMetadata] = useState<{ scope: string; items: ReferenceImage[]; error: string; loading: boolean }>({ scope: '', items: [], error: '', loading: false });
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<{ scope: string; id: string } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  useDialogDismiss({ open: helpOpen, dialogRef: helpRef, modal: false, restoreFocus: false, onDismiss: () => setHelpOpen(false) });
  useEffect(() => {
    if (!lookupIds.length) return;
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setMetadata({ scope, items: [], error: '', loading: true });
    const params = new URLSearchParams({ assetIds: lookupIds.join(',') });
    void fetch(`/api/template-studio/drafts/${encodeURIComponent(draftId)}?${params}`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('参考图读取失败，图片选择仍保留');
      const data = await response.json() as { assets: ReferenceImage[] };
      const items = data.assets.filter(item => lookupIds.includes(item.id));
      if (active) setMetadata({ scope, items, loading: false, error: items.length < lookupIds.length ? '部分参考图已不可用，可移除或重新选择' : '' });
    }).catch(() => {
      if (active) setMetadata({ scope, items: [], loading: false, error: '参考图读取失败，图片选择仍保留' });
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [scope, draftId, lookupIds, retry]);
  // 只缓存按账号和草稿查询的展示信息，选择、用途与顺序仍来自 draft.assets。
  const references: ReferenceImage[] = images.map(asset => metadata.scope === scope ? metadata.items.find(item => item.id === asset.assetId) || { id: asset.assetId } : { id: asset.assetId });
  const previewImage = preview?.scope === scope ? references.find(item => item.id === preview.id) : null;
  const loading = images.length > 0 && (metadata.scope !== scope || metadata.loading);
  const error = images.length > 0 && metadata.scope === scope ? metadata.error : '';
  return <section className={styles.videoReferences} data-video-draft-references aria-label="视频参考图">
    <div className={styles.sectionTitle}>
      <div className={styles.referenceHeading}><span>参考图</span><span className={styles.fieldHint}>{images.length} 张 · 素材合计 {draft.assets.length}/12</span>
        <div ref={helpRef} className={styles.referenceHelp}><button type="button" aria-label="参考图用途" aria-expanded={helpOpen} title="文案生成不读取图片，参考图供后续视频生成使用" onClick={() => setHelpOpen(value => !value)}><Info size={15} /></button>{helpOpen && <span role="tooltip">文案生成仅使用文字说明，不读取图片内容。参考图供后续视频生成使用。</span>}</div>
      </div>
      <button className={styles.quietButton} type="button" disabled={busy || draft.assets.length >= 12} onClick={() => onAdd(null)}><ImagePlus size={15} />添加图片</button>
    </div>
    {slots.some(slot => slot.types.includes('image')) && <div className={styles.referenceSlotTools}>
      {slots.filter(slot => slot.types.includes('image')).map(slot => {
        const count = draft.assets.filter(asset => asset.slotKey === slot.key).length;
        return <button className={styles.quietButton} type="button" key={slot.key} onClick={() => onAdd(slot.key)}
          disabled={busy || draft.assets.length >= 12 || (slot.maxItems != null && count >= slot.maxItems)}>
          <ImagePlus size={14} />{slot.label}{slot.required ? ' *' : ''} <span>{count}/{slot.maxItems ?? '不限'}</span>
        </button>;
      })}
    </div>}
    {images.length > 0 && <StudioReferenceGrid items={references} labels="auxiliary" compact standalone disabled={busy} loading={loading}
      onChange={next => onChange(next.map(item => item.id))}
      onPreview={item => setPreview({ scope, id: item.id })}
      onThumbnailError={item => setMetadata(current => current.scope !== scope ? current : { ...current, error: '部分参考图预览不可用，图片选择仍保留', items: current.items.map(image => image.id === item.id ? { ...image, thumbnailUrl: null } : image) })}
      renderDetails={item => {
        const index = draft.assets.findIndex(asset => asset.assetId === item.id);
        const asset = draft.assets[index];
        const slot = slots.find(candidate => candidate.key === asset.slotKey);
        return <details className={styles.referenceBinding}><summary title="设置图片用途">{slot?.label || (asset.role === 'first' ? '首帧' : asset.role === 'last' ? '尾帧' : slots.length ? '未绑定槽位' : '参考图')}</summary>
          {slots.length > 0 ? <select aria-label={`参考图 ${images.findIndex(image => image.assetId === item.id) + 1} 的模板槽位`} disabled={busy} value={slot?.key || ''} onChange={event => onBind(index, event.target.value)}>
            <option value="">未绑定槽位</option>
            {slots.filter(candidate => candidate.types.includes('image')).map(candidate => {
              const count = draft.assets.filter((value, position) => position !== index && value.slotKey === candidate.key).length;
              return <option key={candidate.key} value={candidate.key} disabled={candidate.maxItems != null && count >= candidate.maxItems && slot?.key !== candidate.key}>{candidate.label}{candidate.required ? ' · 必填' : ''}</option>;
            })}
          </select> : <select aria-label={`参考图 ${images.findIndex(image => image.assetId === item.id) + 1} 的使用位置`} disabled={busy} value={asset.role} onChange={event => onRole(index, event.target.value as StudioAssetInput['role'])}>
            <option value="reference">参考素材</option><option value="first">首帧</option><option value="last">尾帧</option>
          </select>}
        </details>;
      }} />}
    {loading && <span className={styles.fieldHint} role="status">正在读取参考图…</span>}
    {error && <div className={styles.referenceError} role="alert"><span>{error}</span><button className={styles.iconButton} type="button" aria-label="重新读取参考图" title="重新读取参考图" onClick={() => setRetry(value => value + 1)}><RotateCw size={14} /></button></div>}
    {previewImage?.originalUrl && <MediaPreview type="image" src={previewImage.originalUrl} title={previewImage.fileName || '视频参考图'} previewKey={`video-template-reference:${userId}:${draft.id}:${previewImage.id}`} onClose={() => setPreview(null)} />}
  </section>;
}
