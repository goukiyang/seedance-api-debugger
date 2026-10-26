'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import type { MultiviewGenerationDraft } from '@/lib/video/multiview-generation-contract';
import styles from './multiview-generation-confirm.module.css';

type Props = {
  draft: MultiviewGenerationDraft; modelLabel: string; projectName: string; cardTitle?: string;
  points: number | null; busy: boolean; blocked: boolean; notice: string;
  onClose: () => void; onConfirm: () => void; onImageError: () => void;
};

export function MultiviewGenerationConfirmDialog(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useDialogDismiss({ open: true, dialogRef: dialog, initialFocusRef: heading, nativeDialog: true,
    onDismiss: () => { if (!props.busy) props.onClose(); } });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const { draft } = props;
  return createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-busy={props.busy}>
    <div className={styles.frame}>
      <header className={styles.header}>
        <h2 id={titleId} ref={heading} tabIndex={-1}>生成 3D 多视图</h2>
        <button type="button" className={styles.close} aria-label="关闭生成确认" disabled={props.busy} onClick={props.onClose}><X size={20} /></button>
      </header>
      <div className={styles.body}>
        <div className={styles.image}>
          {draft.mainImage && <img key={draft.mainImage.referenceImageId} src={`/api/reference-images/${encodeURIComponent(draft.mainImage.referenceImageId)}/content?variant=preview`} alt="本次生成使用的主图" onError={props.onImageError} />}
        </div>
        <div className={styles.settings}>
          <p className={styles.specification}>{draft.resolution} · {draft.duration} 秒</p>
          <p className={styles.model}>{props.modelLabel} · {draft.ratio === 'adaptive' ? '自动比例' : draft.ratio}</p>
          <details className={styles.details}>
            <summary>查看完整设置</summary>
            <dl>
              <dt>补充要求</dt><dd>{draft.supplement.trim() || '未填写'}</dd>
              <dt>保存到项目</dt><dd>{props.projectName || '待确认'}</dd>
              <dt>视频卡</dt><dd>{props.cardTitle || '不关联视频卡'}</dd>
              <dt>旋转模板</dt><dd>360°旋转</dd>
              <dt>生成声音</dt><dd>{draft.generateAudio ? '开启' : '关闭'}</dd>
              <dt>随机种子</dt><dd>{draft.seed === -1 ? '随机' : draft.seed}</dd>
              <dt>返回末帧</dt><dd>{draft.returnLastFrame ? '开启' : '关闭'}</dd>
              <dt>水印</dt><dd>{draft.watermark ? '开启' : '关闭'}</dd>
            </dl>
          </details>
        </div>
      </div>
      <footer className={styles.footer}>
        {props.notice && <p className={styles.notice} role="status">{props.notice}</p>}
        <p className={styles.price}>{props.points === null ? '报价待确认' : <>预计 <strong>{props.points}</strong> 点</>}</p>
        <div className={styles.actions}>
          <button type="button" disabled={props.busy} onClick={props.onClose}>返回修改</button>
          <button type="button" className={styles.primary} disabled={props.busy || props.blocked} onClick={props.onConfirm}>{props.busy ? '正在提交…' : '确认生成'}</button>
        </div>
      </footer>
    </div>
  </dialog>, document.body);
}
