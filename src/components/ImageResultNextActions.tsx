'use client';
import { Scissors, Video } from 'lucide-react';
import type { ContentKey } from '@/lib/content-reactions/types';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useImageResultNextActions, type ImageResultNextActionsController } from './useImageResultNextActions';

export function ImageResultNextActionFeedback({ controller, className }: { controller: ImageResultNextActionsController; className?: string }) {
  return controller.message ? <p className={className} role="status">{controller.message}{controller.destination && <a href={controller.destination} target="_blank" rel="noopener noreferrer">打开工作区</a>}</p> : null;
}

export function ImageResultNextActions({ sourceKey, resultId, className }: { sourceKey: ContentKey; resultId?: string; className?: string }) {
  const { user } = useAppSession();
  const controller = useImageResultNextActions({ sourceKey, resultId });
  const { busy, open } = controller;
  const admin = user?.role === 'admin';
  return <div className={className} data-image-result-next>
    <div role="group" aria-label="继续创作这张图片">
      <button type="button" disabled={!controller.canCutout} aria-busy={busy === 'cutout'}
        title={controller.cutoutDisabledReason || '带入普通抠图，费用未知时需在目标页确认'} onClick={() => void open('cutout')}><Scissors size={15} />{busy === 'cutout' ? '正在导入…' : '一键抠图'}</button>
      <button type="button" disabled={!controller.canVideo} aria-busy={busy === 'video'} title={controller.videoDisabledReason || '仅带入独立视频首帧，不生成或扣生成点数'} onClick={() => void open('video')}><Video size={15} />{busy === 'video' ? '正在导入…' : '用图生成视频'}</button>
    </div>
    <small>{admin ? '抠图费用待确认；视频仅带图。' : '抠图需业务授权；视频仅带图。'}</small>
    <ImageResultNextActionFeedback controller={controller} />
  </div>;
}
