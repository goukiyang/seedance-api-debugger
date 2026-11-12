'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowLeft, ChevronDown, ChevronUp, Plus, Download, Maximize2 } from 'lucide-react';
import { GuidedDemo } from '@/components/experience/demo/GuidedDemo';
import { ExperienceActions, OperationReceipt } from '@/components/experience/ExperienceParts';
import { RelativeTime } from '@/components/RelativeTime';
import { WorkActions, reuseWorkTemplate, type WorkOperate } from './WorkActions';
import { worksRead, WorksClientError, workWorkspaceTabId, recordWorkEvidence } from '@/lib/works/client';
import { workAudienceLabels, type WorkActivity, type WorkCard } from '@/lib/works/types';
import { AssetPlaybackCoordinator, releaseAssetMediaSource } from '@/lib/media/asset-playback';
import { WorkMedia } from './WorkMedia';
import { WorkPreviewImage } from './WorkPreviewImage';
import { matchesWorkImage, type PreparedWorkImage } from '@/lib/works/image-preview';
import { invalidateImageReadSource } from '@/lib/media/image-read-session';
import { authorizeTaskReuseHref } from '@/lib/navigation/task-reuse';
import { WorkAuthor } from './WorkAuthor';
import { WorkLearning } from './WorkLearning';
import { WorkCompare } from './WorkCompare';
import type { WorkContext, WorkContextGroup } from '@/lib/works/context-types';
import styles from './Works.module.css';

const ZoomableImagePreview = dynamic(() => import('@/components/ZoomableImagePreview').then(component => component.ZoomableImagePreview), { ssr: false });

function RelatedGroup({ group, viewerId, workId, medium, playback, loading, error, hasPrevious, hasWindowStart, onMore, onPrevious, onStart, onOpen, onCompare }: {
  group: WorkContextGroup; viewerId: string; workId: string; medium: WorkCard['medium']; playback: AssetPlaybackCoordinator;
  loading: boolean; error: string; hasPrevious: boolean; hasWindowStart: boolean; onMore: () => void; onPrevious: () => void; onStart: () => void; onOpen: (work: WorkCard) => void; onCompare: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = group.items.filter(work => work.id !== workId), visible = expanded ? items : items.slice(0, 4);
  return <section className={styles.relatedGroup} aria-labelledby={`work-group-${group.id}`}>
    <header className={styles.relatedHeading}><h2 id={`work-group-${group.id}`}>{group.label}</h2>{items.some(item => item.medium === medium) && <button type="button" onClick={onCompare}>选作比较范围</button>}</header>
    {visible.length > 0 ? <div className={styles.relatedGrid}>{visible.map(item => <article key={item.id} className={styles.relatedCard}>
      <button type="button" className={styles.relatedMedia} onClick={() => onOpen(item)} aria-label={`查看作品：${item.title}`}><WorkMedia work={item} playback={playback} contextKey={`${viewerId}:related:${workId}`} detailOpen />
      </button><div className={styles.relatedIdentity}><WorkAuthor author={item.author} />{item.provenance?.template && <a href={item.provenance.template.href} title={item.provenance.template.label}>{item.provenance.template.label}</a>}</div>
    </article>)}</div> : <p className={styles.muted}>目前没有其他可查看的作品。</p>}
    {(items.length > 4 || group.nextCursor || hasPrevious || hasWindowStart) && <div className={styles.groupControls}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}{expanded ? '收起这组' : '展开这组'}</button>
      {expanded && hasPrevious && <button type="button" disabled={loading} onClick={onPrevious}>前一页</button>}
      {expanded && hasWindowStart && <button type="button" disabled={loading} onClick={onStart}>回到这组开头</button>}
      {expanded && group.nextCursor && <button type="button" disabled={loading} onClick={onMore}>{loading ? '正在读取…' : '读取这组更多作品'}</button>}
    </div>}
    {error && <p className={styles.muted} role="status">{error}<button type="button" disabled={loading} onClick={onMore}>重试读取</button></p>}
  </section>;
}

export function WorkDetail({ id, viewerId, preparation, revision, likesRevision, playback, onClose, onList, onOpen, onWork, onActivity, onFilter, onClassify, busy, operate }: {
  id: string; viewerId: string; revision: number; likesRevision: number; playback: AssetPlaybackCoordinator; onClose: () => void; onList: () => void; onOpen: (work: WorkCard) => void;
  preparation?: PreparedWorkImage;
  onWork: (work: WorkCard) => void; onFilter: (key: 'author' | 'project', id: string) => void;
  onActivity: (id: string, mediaVersion: string, activity: WorkActivity) => void;
  onClassify: (work: WorkCard) => void; busy: boolean; operate: WorkOperate;
}) {
  const [work, setWork] = useState<WorkCard | null>(null), [replacement, setReplacement] = useState<WorkCard | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0), [reading, setReading] = useState(false), [mediaFailed, setMediaFailed] = useState(false), [mediaAttempt, setMediaAttempt] = useState(0);
  const [context, setContext] = useState<WorkContext | null>(null), [contextError, setContextError] = useState(''), [contextRetry, setContextRetry] = useState(0), [groupReading, setGroupReading] = useState(''), [groupErrors, setGroupErrors] = useState<Record<string, string>>({}), [methodReading, setMethodReading] = useState(false), [comparing, setComparing] = useState(false), [compareGroup, setCompareGroup] = useState('');
  const [groupPages, setGroupPages] = useState<Record<string, WorkContextGroup[]>>({}), [groupPositions, setGroupPositions] = useState<Record<string, number>>({}), [groupTrimmed, setGroupTrimmed] = useState<Record<string, boolean>>({});
  const [zoomed, setZoomed] = useState(false), [compareOpen, setCompareOpen] = useState(false);
  const detailLease = useRef<number | null>(null), processedRetry = useRef(0), currentWork = useRef(work); currentWork.current = work;
  const video = useRef<HTMLVideoElement>(null), heading = useRef<HTMLHeadingElement>(null), compareArea = useRef<HTMLDivElement>(null), alive = useRef(true), methodBusy = useRef(false), groupBusy = useRef(false), contextGeneration = useRef(0), seekTarget = useRef<number | null>(null);
  const onWorkRef = useRef(onWork); onWorkRef.current = onWork;
  const mediaVersion = work?.mediaVersion;
  const viewed = useRef<string | null>(null);
  const countView = Boolean(work?.activity && work.discoverable && work.detailPreviewUrl && !error && !replacement);
  useEffect(() => {
    if (!mediaVersion || !countView || viewed.current === mediaVersion) return;
    viewed.current = mediaVersion;
    void fetch(`/api/works/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-session-user': viewerId },
      body: JSON.stringify({ viewerId, mediaVersion }),
    }).then(async response => {
      if (!response.ok) return;
      const data = await response.json() as { viewerId: string; activity: WorkActivity };
      if (alive.current && data.viewerId === viewerId) onActivity(id, mediaVersion, data.activity);
    }).catch(() => {});
  }, [countView, id, mediaVersion, onActivity, viewerId]);
  const onCompareActive = useCallback((active: boolean) => {
    if (active) { if (video.current) releaseAssetMediaSource(video.current); playback.stopAll('selection'); }
    setComparing(active);
  }, [playback]);
  useEffect(() => {
    alive.current = true; playback.setModalBlocked(true); heading.current?.focus({ preventScroll: true });
    return () => { alive.current = false; playback.setModalBlocked(false); playback.stopAll('page'); };
  }, [playback]);
  useEffect(() => { if (work?.id) heading.current?.focus({ preventScroll: true }); }, [work?.id]);
  useEffect(() => {
    const media = video.current;
    return () => { if (media) releaseAssetMediaSource(media); detailLease.current = null; };
  }, [work?.mediaVersion, mediaAttempt, comparing]);
  useEffect(() => {
    const controller = new AbortController(), reloadMedia = retry !== processedRetry.current; processedRetry.current = retry; setError(''); setReading(true);
    void (async () => {
      const data = await worksRead<{ viewerId: string; work: WorkCard }>(`/api/works/${encodeURIComponent(id)}`, viewerId, controller.signal);
      if (controller.signal.aborted) return;
      if (preparation && !matchesWorkImage(preparation, preparation.handle.account, data.work)) preparation.handle.release();
      const previous = currentWork.current;
      onWorkRef.current(data.work);
      if (previous && previous.mediaVersion !== data.work.mediaVersion) { playback.stopAll('source'); if (video.current) releaseAssetMediaSource(video.current); setContext(null); setReplacement(data.work); return; }
      setReplacement(null);
      setWork(data.work);
      if (reloadMedia) { setMediaAttempt(value => value + 1); setMediaFailed(false); }
    })().catch(cause => {
      if (controller.signal.aborted) return;
      if (preparation && cause instanceof WorksClientError && [403, 404].includes(cause.status))
        invalidateImageReadSource(preparation.handle.source, preparation.handle.account);
      preparation?.handle.release();
      if (cause instanceof WorksClientError && [403, 404].includes(cause.status)) { playback.stopAll('source'); if (video.current) releaseAssetMediaSource(video.current); setContext(null); setError('当前无法访问这件作品，可能是分享范围或权限已变化。'); }
      else if (currentWork.current && reloadMedia) { setMediaFailed(true); setNotice('预览读取未完成，可重试预览。'); }
      else setError(cause instanceof Error ? cause.message : '作品读取未完成');
    }).finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [id, viewerId, preparation, revision, likesRevision, retry, playback]);
  useEffect(() => {
    if (!mediaVersion || error || replacement) return;
    const controller = new AbortController(); contextGeneration.current++; setContextError('');
    void worksRead<WorkContext>(`/api/works/${encodeURIComponent(id)}/context?${new URLSearchParams({ version: mediaVersion })}`, viewerId, controller.signal).then(data => {
      if (!controller.signal.aborted && data.mediaVersion === currentWork.current?.mediaVersion) { setContext(data); setGroupErrors({}); setGroupPages(Object.fromEntries(data.groups.map(group => [group.id, [group]]))); setGroupPositions({}); setGroupTrimmed({}); }
    }).catch(cause => { if (!controller.signal.aborted) { setContext(null); setContextError(cause instanceof Error ? cause.message : '相关作品读取未完成'); } });
    return () => controller.abort();
  }, [id, viewerId, mediaVersion, error, replacement, contextRetry, revision]);
  function retryPreview() { if (!reading) setRetry(value => value + 1); }
  function openCurrentVersion() {
    if (!replacement) return;
    playback.stopAll('source'); setWork(replacement); currentWork.current = replacement; setReplacement(null); setContext(null); setMediaFailed(false); setMediaAttempt(value => value + 1); setNotice('已打开当前媒体版本，请重新选择要执行的操作。');
  }
  function showGroup(group: WorkContextGroup) { setContext(old => old && ({ ...old, groups: old.groups.map(item => item.id === group.id ? group : item) })); }
  function previousGroup(group: WorkContextGroup) {
    const position = groupPositions[group.id] || 0, previous = groupPages[group.id]?.[position - 1];
    if (previous) { showGroup(previous); setGroupPositions(old => ({ ...old, [group.id]: position - 1 })); }
  }
  async function moreGroup(group: WorkContextGroup, restart = false) {
    const position = groupPositions[group.id] || 0, cached = groupPages[group.id]?.[position + 1];
    if (!restart && cached) { showGroup(cached); setGroupPositions(old => ({ ...old, [group.id]: position + 1 })); return; }
    if ((!restart && !group.nextCursor) || groupBusy.current) return;
    const generation = contextGeneration.current;
    groupBusy.current = true; setGroupReading(group.id); setGroupErrors(old => ({ ...old, [group.id]: '' }));
    try {
      const data = await worksRead<WorkContext>(`/api/works/${encodeURIComponent(id)}/context?${new URLSearchParams({ group: group.id, ...(!restart && group.nextCursor ? { after: group.nextCursor } : {}), version: work!.mediaVersion })}`, viewerId);
      if (!alive.current || generation !== contextGeneration.current || data.mediaVersion !== currentWork.current?.mediaVersion) return;
      const incoming = data.groups.find(item => item.id === group.id);
      if (incoming) {
        const previous = restart ? [] : groupPages[group.id] || [group], next = [...previous, incoming].slice(-6);
        setGroupPages(old => ({ ...old, [group.id]: next })); setGroupPositions(old => ({ ...old, [group.id]: next.length - 1 }));
        if (restart) setGroupTrimmed(old => ({ ...old, [group.id]: false }));
        else if (previous.length >= 6) setGroupTrimmed(old => ({ ...old, [group.id]: true }));
        showGroup(incoming);
      }
    } catch (cause) { if (alive.current) setGroupErrors(old => ({ ...old, [group.id]: cause instanceof Error ? cause.message : '这组作品读取未完成' })); }
    finally { groupBusy.current = false; if (alive.current) setGroupReading(''); }
  }
  async function applyMethod() {
    if (!work || methodBusy.current) return;
    methodBusy.current = true; setMethodReading(true); setNotice('');
    try {
      if (work.medium === 'video' && work.provenance?.videoReferenceHref) {
        const target = new URL(work.provenance.videoReferenceHref, window.location.origin);
        target.searchParams.set('return_to', `${window.location.pathname}${window.location.search}`);
        const href = authorizeTaskReuseHref(`${target.pathname}${target.search}`, viewerId);
        if (!href) { setNotice('复用入口准备失败，浏览器未能保存本次操作，请重试。'); return; }
        window.location.assign(href);
        return;
      }
      if (!context?.method) return;
      if (context.method.action.kind === 'reference') {
        const result = await operate(`work:${work.id}`, `/api/works/${work.id}/reference`, { expectedMediaVersion: work.mediaVersion, tabId: workWorkspaceTabId() });
        if (alive.current && result?.workspaceAssetId) setNotice('已加入生成工作区，可继续使用当前工作区。');
        return;
      }
      if (context.method.template) {
        const href = await reuseWorkTemplate(work, operate, context.method.template.version);
        if (alive.current && href) window.location.assign(href);
      }
    } catch (cause) { if (alive.current) { setNotice(cause instanceof Error ? cause.message : '方法入口读取未完成'); setContextRetry(value => value + 1); } }
    finally { methodBusy.current = false; if (alive.current) setMethodReading(false); }
  }
  function seek(timeSeconds: number) {
    seekTarget.current = timeSeconds;
    const media = video.current;
    if (media && media.readyState >= 1) { media.currentTime = Math.min(timeSeconds, Number.isFinite(media.duration) ? media.duration : timeSeconds); seekTarget.current = null; }
  }
  const previewSource = work?.detailPreviewUrl || (work?.previewStatus === 'ready' ? work.previewUrl : null);
  const videoReferenceHref = work?.medium === 'video' ? work.provenance?.videoReferenceHref : null;
  const blocked = busy || reading || Boolean(replacement), groups = context?.groups || [], firstGroup = groups.find(group => group.id === 'same-template' || group.id === 'same-submission'), remainingGroups = groups.filter(group => group !== firstGroup);
  const source = work?.provenance?.template || work?.provenance?.tool;
  const compareCandidates = (compareGroup ? groups.filter(group => group.id === compareGroup) : groups).flatMap(group => group.items).filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const renderGroup = (group: WorkContextGroup) => <RelatedGroup key={group.id} group={group} viewerId={viewerId} workId={id} medium={work?.medium || 'image'} playback={playback} loading={groupReading === group.id} error={groupErrors[group.id] || ''} hasPrevious={(groupPositions[group.id] || 0) > 0} hasWindowStart={Boolean(groupTrimmed[group.id])} onPrevious={() => previousGroup(group)} onStart={() => void moreGroup(group, true)} onMore={() => void moreGroup(group)} onOpen={onOpen} onCompare={() => { setCompareGroup(group.id); setCompareOpen(true); requestAnimationFrame(() => compareArea.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' as ScrollBehavior : 'smooth', block: 'start' })); requestAnimationFrame(() => compareArea.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })); }} />;
  return <article className={styles.detailPage} aria-labelledby={work && !error ? "work-detail-title" : undefined} aria-label={!work || error ? "作品详情" : undefined}>
    <nav className={styles.detailNav} aria-label="作品导航"><button type="button" onClick={onClose}><ArrowLeft size={18} />返回</button><button type="button" onClick={onList}>作品列表</button></nav>
    {error ? <div className={styles.empty} role="status"><p>{error}</p><button type="button" disabled={reading} onClick={retryPreview}>重试读取</button></div> : !work ? <div className={styles.detailSkeleton} role="status">正在读取作品…</div> : <>
      <div className={styles.detailLayout}>
        <div className={styles.detailPrimary}>
          {!comparing && <div className={styles.detailMedia} style={{ aspectRatio: work.width && work.height ? `${work.width}/${work.height}` : undefined }}>
            {replacement ? <div className={styles.previewMessage} role="status"><p>媒体版本已变化，请打开当前版本后重新操作。</p><button type="button" onClick={openCurrentVersion}>打开当前版本</button></div> : mediaFailed || !previewSource ? <div className={styles.previewMessage} role="status"><p>{mediaFailed ? '预览读取未完成。' : work.previewStatus === 'preparing' ? '预览正在准备。' : '当前预览不可用。'}</p><button type="button" disabled={reading} onClick={retryPreview}>{reading ? '正在读取…' : mediaFailed ? '重试预览' : '重新读取预览'}</button></div> : work.medium === 'image' ? <button type="button" className={styles.imageZoomTrigger} onClick={() => setZoomed(true)} aria-label="放大图片"><WorkPreviewImage key={`${work.mediaVersion}:${mediaAttempt}`} work={work} preparation={preparation} attempt={mediaAttempt} onFailure={() => setMediaFailed(true)} /><span className={styles.zoomHint}><Maximize2 size={16} /></span></button> : <video key={`${work.mediaVersion}:${mediaAttempt}`} ref={video} src={previewSource!} poster={work.thumbnailUrl || undefined} controls playsInline muted preload="metadata" onError={() => setMediaFailed(true)} onLoadedMetadata={event => { if (seekTarget.current !== null) { event.currentTarget.currentTime = Math.min(seekTarget.current, event.currentTarget.duration); seekTarget.current = null; } }} onPlay={event => { detailLease.current = playback.claimDetail(`${work.id}:${work.mediaVersion}`, previewSource!, event.currentTarget); }} onPause={event => { if (detailLease.current !== null) playback.releaseDetail(detailLease.current, `${work.id}:${work.mediaVersion}`, previewSource!, event.currentTarget); detailLease.current = null; }} />}
          </div>}
          <div className={styles.detailInfo}>
            <div className={styles.detailByline}><WorkAuthor author={work.author} onClick={() => onFilter('author', work.author.id)} /><RelativeTime value={work.completedAt} /><WorkActions work={work} busy={blocked} operate={operate} onClassify={onClassify} /></div>
            <h1 ref={heading} tabIndex={-1} id="work-detail-title" className={styles.sourceTitle}>{source ? <a href={source.href}>{source.label}</a> : '作品详情'}</h1>
            <ExperienceActions label="继续使用作品" className={styles.detailSource}>
              {work.provenance?.template && <a href={work.provenance.tool.href}>{work.provenance.tool.label}</a>}
              {(videoReferenceHref || work.provenance?.template) && <button type="button" className={styles.primary} disabled={blocked || methodReading || !videoReferenceHref && context?.method?.action.kind !== 'template'} title={videoReferenceHref ? undefined : context?.method?.action.reason} onClick={() => void applyMethod()}>{methodReading ? '正在准备…' : '一键参考'}</button>}
            </ExperienceActions>
            {work.provenance?.template && <GuidedDemo kind="reuse" />}
            {notice && <OperationReceipt className={styles.notice} status={notice}
              actions={notice.startsWith('已加入') && <a href="/generate" className={styles.textAction}>打开生成工作区</a>} />}
            <WorkLearning work={work} viewerId={viewerId} disabled={blocked || comparing} onSeek={work.medium === 'video' && !comparing ? seek : undefined} />
            <details className={styles.metadata}><summary>作品信息与操作</summary>
              {work.title && <p>{work.title}</p>}
              <p>{workAudienceLabels[work.audience]}{work.width && work.height ? ` · ${work.width} × ${work.height}` : ''}</p>
              {work.project && <button type="button" onClick={() => onFilter('project', work.project!.id)}>{work.project.name}</button>}
              {context?.delivery && <p>{context.delivery.label}</p>}
              {context?.method?.settings.length ? <dl className={styles.methodSettings}>{context.method.settings.map(item => <div key={item.key}><dt>{item.label}</dt><dd>{typeof item.value === 'boolean' ? item.value ? '是' : '否' : String(item.value)}</dd></div>)}</dl> : null}
              {!videoReferenceHref && context?.method?.action.reason && <p>{context.method.action.reason}</p>}
              {context?.method?.template && <p>原模板版本 {context.method.template.version}</p>}
              <div className={styles.detailControls}>
                {!replacement && work.downloadUrl && <a href={work.downloadUrl} download className={styles.textAction}><Download size={16} />下载原件</a>}
                {work.reuse && <button type="button" disabled={blocked || methodReading} onClick={async () => { const result = await operate(`work:${work.id}`, `/api/works/${work.id}/reference`, { expectedMediaVersion: work.mediaVersion, tabId: workWorkspaceTabId() }); if (result?.workspaceAssetId) setNotice('已加入生成工作区，可继续使用当前工作区。'); }}><Plus size={16} />用作参考图</button>}
                {work.medium === 'video' && work.previewStatus === 'not-prepared' && <button type="button" disabled={blocked} onClick={() => void operate(`preview:${work.id}:${work.mediaVersion}`, `/api/works/${work.id}/preview`, { expectedMediaVersion: work.mediaVersion })}>准备轻预览</button>}
                <button type="button" disabled={reading} onClick={retryPreview}>{reading ? '正在读取…' : '重新读取预览'}</button>
              </div>
              {work.withdrawn && <p>已撤回分享</p>}{!work.discoverable && <p>已移出广场</p>}
            </details>
            <details open={compareOpen} onToggle={event => setCompareOpen(event.currentTarget.open)} className={styles.metadata}><summary>比较作品</summary><div ref={compareArea} className={styles.compareArea}>
              {compareOpen && <GuidedDemo kind="compare" />}
              {groups.length > 1 && <label className={styles.compareScope}>比较范围<select value={compareGroup} disabled={comparing} onChange={event => setCompareGroup(event.target.value)}><option value="">全部相关作品</option>{groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label>}
              {compareOpen && <WorkCompare work={work} viewerId={viewerId} playback={playback} candidates={compareCandidates} disabled={blocked} onActiveChange={onCompareActive} />}
            </div></details>

          </div>
        </div>
        <aside className={styles.relatedRail} aria-label="相关作品">{firstGroup ? renderGroup(firstGroup) : contextError ? <div className={styles.readError} role="status"><p>{contextError}</p><button type="button" onClick={() => setContextRetry(value => value + 1)}>重试相关作品</button></div> : !context ? <div className={styles.relatedSkeleton} role="status">正在读取相关作品…</div> : <p className={styles.muted}>{context.indexing ? '正在整理这件作品的关联。' : '目前没有其他可查看的相关作品。'}</p>}</aside>
      </div>
      {remainingGroups.length > 0 && <details className={styles.metadata}><summary>更多相关作品</summary><div className={styles.relatedBelow}>{remainingGroups.map(renderGroup)}</div></details>}
    </>}
    {zoomed && work && previewSource && !error && !replacement && <ZoomableImagePreview src={previewSource} thumbnailSrc={work.thumbnailUrl || undefined} alt={work.title || '作品图片'} previewKey={`work:${work.id}:${work.mediaVersion}`} previewOnly={!work.downloadUrl} imageSharing={false} onFullSizeCopied={() => recordWorkEvidence(viewerId, work.id, work.mediaVersion, { kind: 'copy' })} safeDetails={{ width: work.width || undefined, height: work.height || undefined }} resolveDownload={() => work.downloadUrl ? () => { window.location.assign(work.downloadUrl!); } : undefined} onClose={() => setZoomed(false)} />}
  </article>;
}
