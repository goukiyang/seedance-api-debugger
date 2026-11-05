'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
import { Scissors, Video, X } from 'lucide-react';
import { ExperienceActions, OperationReceipt } from '@/components/experience/ExperienceParts';
import type { ContentKey } from '@/lib/content-reactions/types';
import { useDialogDismiss } from './useDialogDismiss';
import { useImageResultNextActions, type ImageResultNextActionsController } from './useImageResultNextActions';
import styles from './GeneratedImageResults.module.css';

export function ImageResultNextActionFeedback({ controller, anchorRef, className }: {
  controller: ImageResultNextActionsController; anchorRef?: RefObject<HTMLElement | null>; className?: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const messageKey = `${controller.busy || ''}\u0000${controller.message}\u0000${controller.destination}`;
  const [dismissed, setDismissed] = useState('');
  const open = Boolean(controller.message && dismissed !== messageKey);
  const close = () => setDismissed(messageKey);
  useEffect(() => { setDismissed(''); }, [controller.busy, controller.destination, controller.message]);
  useDialogDismiss({ open: open && Boolean(anchorRef?.current), dialogRef: layer, onDismiss: close, modal: false });

  if (!controller.message) return null;
  if (!anchorRef) return <OperationReceipt className={className} status={controller.message}
    actions={controller.destination && <a href={controller.destination} target="_blank" rel="noopener noreferrer">打开工作区</a>} />;
  if (!open || !anchorRef.current) return null;

  return <Popper.Root><Popper.Anchor virtualRef={anchorRef} />{createPortal(<Popper.Content ref={layer}
    side="bottom" align="end" sideOffset={5} collisionPadding={12} sticky="always" hideWhenDetached
    className={`${styles.operationFeedback} ${styles.nextActionFeedback}${className ? ` ${className}` : ''}`}
    aria-busy={Boolean(controller.busy) || undefined}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}>
    <span role="status" aria-live="polite" aria-atomic="true">{controller.message}</span>
    {controller.destination && <a href={controller.destination} target="_blank" rel="noopener noreferrer">打开工作区</a>}
    {!controller.busy && <button type="button" aria-label="关闭操作反馈" title="关闭" onClick={close}><X size={14} /></button>}
  </Popper.Content>, anchorRef.current.closest('dialog[open]') || document.body)}</Popper.Root>;
}

export function ImageResultNextActionButtons({ controller, iconOnly = false, className }: {
  controller: ImageResultNextActionsController; iconOnly?: boolean; className?: string;
}) {
  const { busy, open } = controller;
  const cutoutLabel = busy === 'cutout' ? '正在导入抠图' : '一键抠图';
  const videoLabel = busy === 'video' ? '正在导入视频工作区' : '用图生成视频';
  return <ExperienceActions label="继续创作这张图片" className={className} data-image-result-next>
    <button type="button" disabled={!controller.canCutout} aria-busy={busy === 'cutout'}
      aria-label={controller.cutoutDisabledReason ? `${cutoutLabel}，${controller.cutoutDisabledReason}` : cutoutLabel}
      title={controller.cutoutDisabledReason || '带入普通抠图，费用在目标页确认'} onClick={() => void open('cutout')}>
      <Scissors size={15} />{!iconOnly && (busy === 'cutout' ? '正在导入…' : '一键抠图')}
    </button>
    <button type="button" disabled={!controller.canVideo} aria-busy={busy === 'video'}
      aria-label={controller.videoDisabledReason ? `${videoLabel}，${controller.videoDisabledReason}` : videoLabel}
      title={controller.videoDisabledReason || '带入首帧，不立即生成'} onClick={() => void open('video')}>
      <Video size={15} />{!iconOnly && (busy === 'video' ? '正在导入…' : '用图生成视频')}
    </button>
  </ExperienceActions>;
}

export function ImageResultNextActions({ sourceKey, resultId, className }: { sourceKey: ContentKey; resultId?: string; className?: string }) {
  const anchor = useRef<HTMLDivElement>(null);
  const controller = useImageResultNextActions({ sourceKey, resultId });
  return <div ref={anchor} className={className}>
    <ImageResultNextActionButtons controller={controller} />
    <ImageResultNextActionFeedback controller={controller} anchorRef={anchor} />
  </div>;
}
