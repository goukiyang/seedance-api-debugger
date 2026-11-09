'use client';

import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { worksRead, WorksClientError } from '@/lib/works/client';
import type { WorkCard, WorkPage } from '@/lib/works/types';
import type { AssetPlaybackCoordinator } from '@/lib/media/asset-playback';
import { WorkMedia } from './WorkMedia';
import { WorkAuthor } from './WorkAuthor';
import { reuseWorkTemplate, type WorkOperate } from './WorkActions';
import styles from './Works.module.css';

export function WorkDiscoveries({ viewerId, queryKey, revision, playback, onOpen, onLayout, operate, busyKeys, navigationEpoch }: {
  viewerId: string; queryKey: string; revision: number; playback: AssetPlaybackCoordinator; onOpen: (work: WorkCard) => void; onLayout: () => void;
  operate: WorkOperate; busyKeys: Set<string>; navigationEpoch: MutableRefObject<number>;
}) {
  const [items, setItems] = useState<WorkCard[]>([]), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  const currentItems = loadedKey === queryKey ? items : [];
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function reference(work: WorkCard) {
    const epoch = navigationEpoch.current, version = work.provenance?.template?.reuseVersion;
    if (!version) return;
    const href = await reuseWorkTemplate(work, operate, version);
    if (mounted.current && epoch === navigationEpoch.current && href) window.location.assign(href);
  }
  useLayoutEffect(onLayout, [onLayout, currentItems.length, error]);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    setError('');
    const read = async () => {
      if (busy || controller.signal.aborted || document.visibilityState !== 'visible') return;
      busy = true;
      const params = new URLSearchParams(queryKey); params.set('scope', 'discoveries');
      try {
        const data = await worksRead<WorkPage>(`/api/works?${params}`, viewerId, controller.signal);
        if (!controller.signal.aborted) { setItems(data.items); setLoadedKey(queryKey); setError(''); }
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof WorksClientError && [401, 403, 404].includes(cause.status)) setItems([]);
          setError('新作暂时无法读取');
        }
      } finally { busy = false; }
    };
    const resume = () => { void read(); };
    void read();
    const timer = window.setInterval(resume, 30_000);
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, [viewerId, queryKey, revision, retry]);
  if (!currentItems.length && !error) return null;
  return <section className={styles.discoveries} aria-label="新作发现">
    <header><h2>新作发现</h2>{error && <button type="button" onClick={() => setRetry(value => value + 1)} title={error} aria-label="重试读取新作"><RefreshCw size={15} />{error}</button>}</header>
    <div className={styles.discoveryGrid}>{currentItems.map(work => <article key={work.id}>
      <div className={styles.cardVisual}>
      <button type="button" className={styles.discoveryMedia} onClick={() => onOpen(work)} aria-label={`查看新作：${work.title}`}>
        <WorkMedia work={work} playback={playback} contextKey={`${viewerId}:discoveries:${queryKey}`} detailOpen={false} />
      </button>
      {work.provenance?.template?.reuseVersion && <button type="button" className={styles.reuseButton}
        disabled={busyKeys.has(`work:${work.id}`)} onClick={() => void reference(work)}><span>一键参考</span><ArrowUpRight size={15} aria-hidden="true" /></button>}
      </div>
      <div className={styles.cardInfo}>
        <div className={styles.cardSource}>{work.provenance && <a href={(work.provenance.template || work.provenance.tool).href}
          title={`${work.provenance.tool.label} · ${(work.provenance.template || work.provenance.tool).label}`}>{(work.provenance.template || work.provenance.tool).label}</a>}</div>
        <div className={styles.cardIdentity}><WorkAuthor author={work.author} /></div>
      </div>
    </article>)}</div>
  </section>;
}
