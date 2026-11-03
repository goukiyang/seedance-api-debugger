'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Download, ExternalLink, X } from 'lucide-react';
import { RelativeTime } from '@/components/RelativeTime';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { WorkActions, type WorkOperate } from './WorkActions';
import { worksRead, WorksClientError, workWorkspaceTabId } from '@/lib/works/client';
import { workAudienceLabels, type WorkCard } from '@/lib/works/types';
import { AssetPlaybackCoordinator, releaseAssetMediaSource } from '@/lib/media/asset-playback';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { prepareImagePreview, type ImagePreviewPreparation, type PreparedImagePreviewState } from '@/lib/media/image-preview-session';
import { invalidateImageReadSource } from '@/lib/media/image-read-session';
import styles from './Works.module.css';

function WorkDetailImage({ work, attempt, onFailure }: { work: WorkCard; attempt: number; onFailure: () => void }) {
  const { user, hasLoadedUser, userLoadError, sessionChanged } = useAppSession();
  const account = hasLoadedUser && !userLoadError && !sessionChanged ? `${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}` : '';
  const source = work.detailPreviewUrl || work.previewUrl || '', previewOnly = !work.downloadUrl && !work.reuse;
  const key = JSON.stringify([account, source, attempt, previewOnly]);
  const [prepared, setPrepared] = useState<{ key: string; handle: ImagePreviewPreparation; state: PreparedImagePreviewState } | null>(null);
  const failure = useRef(onFailure); failure.current = onFailure;
  useEffect(() => {
    if (!account || !source) return;
    if (attempt) invalidateImageReadSource(source, account);
    // The URL binds the Work version; HD describes its own file version.
    const handle = prepareImagePreview({ account, source, previewOnly });
    const release = handle.subscribe(state => setPrepared({ key, handle, state }));
    handle.release(); return release;
  }, [key, account, source, attempt, previewOnly]);
  const current = prepared?.key === key ? prepared : null;
  useEffect(() => {
    if (current && (current.state.denied || current.state.result.unconfirmed || ['unavailable', 'unsupported'].includes(current.state.result.progress.phase))) failure.current();
  }, [current]);
  return <img src={!account || current?.state.denied ? undefined : current?.state.result.decoded ? current.state.result.imageSrc || undefined : work.thumbnailUrl || undefined} alt={work.title}
    onError={() => { if (current?.state.result.decoded) failure.current(); }}
    onLoad={event => {
      const image = event.currentTarget;
      if (current?.state.result.decoded && image.currentSrc === current.state.result.imageSrc) requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!document.hidden && image.isConnected && current.handle.isCurrent()) current.handle.markDisplayed();
      }));
    }} />;
}

export function WorkDetail({ id, viewerId, revision, playback, onClose, onWork, onFilter, onClassify, busy, operate }: {
  id: string; viewerId: string; revision: number; playback: AssetPlaybackCoordinator; onClose: () => void;
  onWork: (work: WorkCard) => void; onFilter: (key: 'author' | 'project', id: string) => void;
  onClassify: (work: WorkCard) => void; busy: boolean; operate: WorkOperate;
}) {
  const [work, setWork] = useState<WorkCard | null>(null), [replacement, setReplacement] = useState<WorkCard | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0), [reading, setReading] = useState(false), [mediaFailed, setMediaFailed] = useState(false), [mediaAttempt, setMediaAttempt] = useState(0);
  const detailLease = useRef<number | null>(null), processedRetry = useRef(0), currentWork = useRef(work); currentWork.current = work;
  const dialog = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null), video = useRef<HTMLVideoElement>(null);
  const onWorkRef = useRef(onWork); onWorkRef.current = onWork;
  useDialogDismiss({ open: true, dialogRef: dialog, dismissSurfaceRef: surface, initialFocusRef: close, onDismiss: onClose });
  useEffect(() => { playback.setModalBlocked(true); return () => { playback.setModalBlocked(false); const media = video.current; if (media) releaseAssetMediaSource(media); playback.stopAll('drawer-close'); }; }, [playback]);
  useEffect(() => {
    const controller = new AbortController(), reloadMedia = retry !== processedRetry.current; processedRetry.current = retry; setError(''); setReading(true);
    void (async () => {
      const data = await worksRead<{ viewerId: string; work: WorkCard }>(`/api/works/${encodeURIComponent(id)}`, viewerId, controller.signal);
      if (controller.signal.aborted) return;
      const previous = currentWork.current;
      onWorkRef.current(data.work);
      if (previous && previous.mediaVersion !== data.work.mediaVersion) { playback.stopAll('source'); if (video.current) releaseAssetMediaSource(video.current); setReplacement(data.work); return; }
      setReplacement(null);
      if (!reloadMedia) { setWork(data.work); return; }
      setWork(data.work); setMediaAttempt(value => value + 1); setMediaFailed(false);
    })().catch(cause => {
      if (controller.signal.aborted) return;
      if (cause instanceof WorksClientError && [403, 404].includes(cause.status)) setError('当前无法访问这件作品，可能是分享范围或权限已变化。');
      else if (currentWork.current && reloadMedia) { setMediaFailed(true); setNotice('预览读取未完成，可重试预览。'); }
      else setError(cause instanceof Error ? cause.message : '作品读取未完成');
    }).finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [id, viewerId, revision, retry, playback]);
  function retryPreview() { if (!reading) setRetry(value => value + 1); }
  function openCurrentVersion() {
    if (!replacement) return;
    playback.stopAll('source'); setWork(replacement); currentWork.current = replacement; setReplacement(null); setMediaFailed(false); setMediaAttempt(value => value + 1); setNotice('已打开当前媒体版本，请重新选择要执行的操作。');
  }
  const previewSource = work?.detailPreviewUrl || (work?.previewStatus === 'ready' ? work.previewUrl : null);
  const blocked = busy || reading || Boolean(replacement);
  return createPortal(<div ref={surface} className={styles.backdrop}><div ref={dialog} className={styles.detail} role="dialog" aria-modal="true" aria-labelledby="work-detail-title">
    <header className={styles.detailHeader}><h2 id="work-detail-title">{work?.title || '作品详情'}</h2><button ref={close} type="button" aria-label="关闭作品详情" onClick={onClose}><X size={20} /></button></header>
    {error ? <div className={styles.empty} role="status"><p>{error}</p><button type="button" disabled={reading} onClick={retryPreview}>重试读取</button></div> : !work ? <div className={styles.skeleton} role="status">正在读取作品…</div> : <>
      <div className={styles.detailMedia}>
        {replacement ? <div className={styles.previewMessage} role="status"><p>媒体版本已变化，请打开当前版本后重新操作。</p><button type="button" onClick={openCurrentVersion}>打开当前版本</button></div> : mediaFailed || !previewSource ? <div className={styles.previewMessage} role="status"><p>{mediaFailed ? '预览读取未完成。' : work.previewStatus === 'preparing' ? '预览正在准备。' : '当前预览不可用。'}</p><button type="button" disabled={reading} onClick={retryPreview}>{reading ? '正在读取…' : mediaFailed ? '重试预览' : '重新读取预览'}</button></div> : work.medium === 'image' ? <WorkDetailImage key={`${work.mediaVersion}:${mediaAttempt}`} work={work} attempt={mediaAttempt} onFailure={() => setMediaFailed(true)} /> : <video key={`${work.mediaVersion}:${mediaAttempt}`} ref={video} src={previewSource!} poster={work.thumbnailUrl || undefined} controls playsInline muted preload="metadata" onError={() => setMediaFailed(true)} onPlay={event => { detailLease.current = playback.claimDetail(`${work.id}:${work.mediaVersion}`, previewSource!, event.currentTarget); }} onPause={event => { if (detailLease.current !== null) playback.releaseDetail(detailLease.current, `${work.id}:${work.mediaVersion}`, previewSource!, event.currentTarget); detailLease.current = null; }} />}
      </div>
      <div className={styles.detailInfo}><div className={styles.identity}><button type="button" onClick={() => onFilter('author', work.author.id)}>{work.author.name}</button>{work.project && <button type="button" onClick={() => onFilter('project', work.project!.id)}>{work.project.name}</button>}<RelativeTime value={work.completedAt} /></div>
        <div className={styles.detailControls}><WorkActions work={work} busy={blocked} operate={operate} onClassify={onClassify} />
          {!replacement && work.downloadUrl && <a href={work.downloadUrl} download className={styles.textAction}><Download size={16} />下载原件</a>}
          {work.reuse && <button type="button" disabled={blocked} onClick={async () => { const result = await operate(`work:${work.id}`, `/api/works/${work.id}/reference`, { expectedMediaVersion: work.mediaVersion, tabId: workWorkspaceTabId() }); if (result?.workspaceAssetId) setNotice('已加入生成工作区，可继续使用当前工作区。'); }}><Plus size={16} />加入生成工作区</button>}
          {work.sourceHref && <a href={work.sourceHref} className={styles.textAction}><ExternalLink size={16} />打开原记录</a>}
          <button type="button" disabled={reading} onClick={retryPreview}>{reading ? '正在读取…' : '重新读取预览'}</button>
        </div>
        {notice && <p className={styles.notice} role="status">{notice}{notice.startsWith('已加入') && <a href="/generate" className={styles.textAction}>打开生成工作区</a>}</p>}
        <details className={styles.metadata}><summary>作品信息</summary><p>{workAudienceLabels[work.audience]}{work.width && work.height ? ` · ${work.width} × ${work.height}` : ''}</p><p>作品编号 {work.id}</p>{work.withdrawn && <p>已撤回分享</p>}{!work.discoverable && <p>已移出广场</p>}</details>
      </div>
    </>}
  </div></div>, document.body);
}
