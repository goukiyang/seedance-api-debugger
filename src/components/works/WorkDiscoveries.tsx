'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { worksRead, WorksClientError } from '@/lib/works/client';
import type { WorkCard, WorkPage } from '@/lib/works/types';
import type { AssetPlaybackCoordinator } from '@/lib/media/asset-playback';
import { WorkMedia } from './WorkMedia';
import { WorkAuthor } from './WorkAuthor';
import styles from './Works.module.css';

export function WorkDiscoveries({ viewerId, queryKey, revision, playback, onOpen, onLayout }: {
  viewerId: string; queryKey: string; revision: number; playback: AssetPlaybackCoordinator; onOpen: (work: WorkCard) => void; onLayout: () => void;
}) {
  const [items, setItems] = useState<WorkCard[]>([]), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  const currentItems = loadedKey === queryKey ? items : [];
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
      <button type="button" className={styles.discoveryMedia} onClick={() => onOpen(work)} aria-label={`查看新作：${work.title}`}>
        <WorkMedia work={work} playback={playback} contextKey={`${viewerId}:discoveries:${queryKey}`} detailOpen={false} />
      </button>
      <WorkAuthor author={work.author} />
    </article>)}</div>
  </section>;
}
