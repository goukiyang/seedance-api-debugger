'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExperienceActions } from '@/components/experience/ExperienceParts';
import { AssetPlaybackCoordinator, releaseAssetMediaSource } from '@/lib/media/asset-playback';
import { worksRead } from '@/lib/works/client';
import type { WorkCard } from '@/lib/works/types';
import type { WorkContext, WorkMethod } from '@/lib/works/context-types';
import { WorkPreviewImage } from './WorkPreviewImage';
import styles from './WorkLearning.module.css';

const source = (work: WorkCard) => work.detailPreviewUrl || (work.previewStatus === 'ready' ? work.previewUrl : null);
const secondsText = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const settingText = (value: string | number | boolean | undefined) => value === undefined ? '未提供' : typeof value === 'boolean' ? value ? '是' : '否' : String(value);

export function WorkCompare({ work, viewerId, candidates, playback, disabled = false, onActiveChange }: {
  work: WorkCard; viewerId: string; candidates: WorkCard[]; playback: AssetPlaybackCoordinator;
  disabled?: boolean; onActiveChange?: (active: boolean) => void;
}) {
  const [reversed, setReversed] = useState(false);
  const columns = reversed ? [1, 0] as const : [0, 1] as const;
  const [selected, setSelected] = useState(''), [pair, setPair] = useState<[WorkCard, WorkCard] | null>(null);
  const [methods, setMethods] = useState<[WorkMethod | null, WorkMethod | null]>([null, null]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0), [durations, setDurations] = useState<[number | null, number | null]>([null, null]);
  const [audio, setAudio] = useState<'none' | 'left' | 'right'>('none'), [rate, setRate] = useState(1);
  const left = useRef<HTMLVideoElement>(null), right = useRef<HTMLVideoElement>(null), session = useRef(0);
  const pairOwner = useRef('');
  const onActive = useRef(onActiveChange); onActive.current = onActiveChange;
  const identity = `${viewerId}:${work.id}:${work.mediaVersion}`, current = useRef(identity); current.current = identity;
  const options = useMemo(() => Array.from(new Map(candidates.filter(item => item.id !== work.id && item.medium === work.medium).map(item => [item.id, item])).values()).slice(0, 96), [candidates, work.id, work.medium]);
  const duration = durations[0] !== null && durations[1] !== null ? Math.min(durations[0], durations[1]) : null;
  const activePair = pair && pairOwner.current === identity ? pair : null;
  function pause() { left.current?.pause(); right.current?.pause(); setPlaying(false); }
  const close = useCallback(() => {
    session.current += 1;
    if (left.current) releaseAssetMediaSource(left.current);
    if (right.current) releaseAssetMediaSource(right.current);
    setPair(null); setPlaying(false); setDurations([null, null]); setTime(0); setAudio('none'); setRate(1); setBusy(false);
  }, []);
  useEffect(() => {
    setReversed(false); setSelected(''); setError(''); setPair(null); setPlaying(false); setDurations([null, null]); setAudio('none'); setTime(0); setBusy(false);
    session.current += 1;
    return () => { session.current += 1; };
  }, [identity]);
  useEffect(() => {
    if (!pair) return;
    playback.stopAll('selection');
    onActive.current?.(true);
    const first = left.current, second = right.current;
    const hide = () => { if (document.hidden) { first?.pause(); second?.pause(); setPlaying(false); } };
    document.addEventListener('visibilitychange', hide);
    return () => {
      session.current += 1;
      if (first) releaseAssetMediaSource(first);
      if (second) releaseAssetMediaSource(second);
      document.removeEventListener('visibilitychange', hide);
      onActive.current?.(false);
    };
  }, [pair, playback]);
  useEffect(() => { if (disabled) close(); }, [disabled, close]);
  useEffect(() => {
    if (left.current) { left.current.muted = audio !== 'left'; left.current.playbackRate = rate; }
    if (right.current) { right.current.muted = audio !== 'right'; right.current.playbackRate = rate; }
  }, [audio, rate, pair]);
  const differences = useMemo(() => {
    const settings = methods.map(method => new Map(method?.settings.map(item => [item.key, item]) || []));
    return Array.from(new Set([...Array.from(settings[0].keys()), ...Array.from(settings[1].keys())])).flatMap(key => {
      const a = settings[0].get(key), b = settings[1].get(key);
      return a?.value === b?.value ? [] : [{ key, label: a?.label || b?.label || key, left: a?.value, right: b?.value }];
    });
  }, [methods]);
  async function enter() {
    const candidate = options.find(item => item.id === selected);
    if (!candidate || busy || disabled) return;
    const captured = identity, attempt = ++session.current;
    setBusy(true); setError('');
    try {
      const read = async (card: WorkCard) => {
        const query = new URLSearchParams({ version: card.mediaVersion });
        const [detail, context] = await Promise.all([
          worksRead<{ viewerId: string; work: WorkCard }>(`/api/works/${encodeURIComponent(card.id)}`, viewerId),
          worksRead<WorkContext>(`/api/works/${encodeURIComponent(card.id)}/context?${query}`, viewerId),
        ]);
        if (detail.work.mediaVersion !== card.mediaVersion || context.mediaVersion !== card.mediaVersion || detail.work.medium !== card.medium) throw new Error('作品版本已变化，请刷新详情后重新选择比较。');
        if (!source(detail.work)) throw new Error('当前作品预览尚不可用，请稍后重新读取。');
        return { work: detail.work, method: context.method };
      };
      const [first, second] = await Promise.all([read(work), read(candidate)]);
      if (current.current !== captured || session.current !== attempt) return;
      playback.stopAll('selection');
      setAudio('none'); setRate(1); setDurations([null, null]); setTime(0); setPlaying(false);
      setReversed(false); pairOwner.current = captured; setMethods([first.method, second.method]); setPair([first.work, second.work]);
    } catch (cause) {
      if (current.current === captured && session.current === attempt) setError(cause instanceof Error ? cause.message : '比较读取未完成，请重试。');
    } finally { if (current.current === captured && session.current === attempt) setBusy(false); }
  }
  function seek(value: number) {
    if (duration === null || !Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(duration, value));
    if (left.current) left.current.currentTime = next;
    if (right.current) right.current.currentTime = next;
    setTime(next);
  }
  async function play() {
    if (playing) { pause(); return; }
    const first = left.current, second = right.current, attempt = session.current;
    if (!first || !second || duration === null) return;
    if (first.currentTime >= duration) seek(0);
    second.currentTime = first.currentTime;
    playback.stopAll('detail-play');
    try {
      await Promise.all([first.play(), second.play()]);
      if (session.current !== attempt || left.current !== first || right.current !== second) {
        first.pause(); second.pause(); return;
      }
      setPlaying(true);
    } catch {
      first.pause(); second.pause();
      if (session.current === attempt) { setPlaying(false); setError('播放未开始，请再次点击播放。'); }
    }
  }
  function tick() {
    const first = left.current, second = right.current;
    if (!first || !second || duration === null) return;
    if (first.currentTime >= duration) { pause(); seek(duration); return; }
    setTime(first.currentTime);
    if (!first.paused && Math.abs(second.currentTime - first.currentTime) > 0.2) second.currentTime = first.currentTime;
  }
  function mediaError() { close(); setError('比较媒体当前不可用，请刷新作品后重新进入。'); }
  function changeAudio(value: 'none' | 'left' | 'right') {
    if (left.current) left.current.muted = true;
    if (right.current) right.current.muted = true;
    setAudio(value);
  }
  if (!options.length && !activePair) return null;
  return <section className={styles.compare} aria-label="作品比较">
    <div className={styles.heading}><h2>并排比较</h2>{activePair && <ExperienceActions label="对比操作">
      <button type="button" onClick={() => { pause(); setReversed(value => !value); }}>交换左右</button>
      <button type="button" onClick={close}>退出比较</button>
    </ExperienceActions>}</div>
    {error && <p className={styles.error} role="status">{error}</p>}
    {!activePair ? <div className={styles.row}><label className={styles.compareSelect}>比较作品<select value={selected} disabled={busy || disabled} onChange={event => setSelected(event.target.value)}>
      <option value="">选择同组作品</option>{options.map(item => <option key={item.id} value={item.id}>{item.title} · {item.author.name}</option>)}
    </select></label><button type="button" disabled={!selected || busy || disabled} onClick={() => void enter()}>{busy ? '读取比较…' : '进入比较'}</button></div> : <>
      <div className={styles.comparisonPanes}>{columns.map(index => {
        const item = activePair[index];
        return <figure key={`${item.id}:${item.mediaVersion}`} className={styles.pane}>
        <figcaption>{item.title}<span>{item.author.name}</span></figcaption>
        <div className={styles.comparisonMedia}>{item.medium === 'image' ? <WorkPreviewImage work={item} attempt={0} onFailure={mediaError} /> :
          <video ref={index === 0 ? left : right} src={source(item)!} poster={item.thumbnailUrl || undefined} playsInline muted={audio !== (index === 0 ? 'left' : 'right')} preload="metadata"
            aria-label={`${index === columns[0] ? '左侧' : '右侧'}比较视频：${item.title}`} onError={mediaError} onEnded={pause}
            onPause={() => { const other = index === 0 ? right.current : left.current; other?.pause(); setPlaying(false); }}
            onTimeUpdate={index === 0 ? tick : undefined} onLoadedMetadata={event => { const value = event.currentTarget.duration;
              setDurations(previous => index === 0 ? [Number.isFinite(value) && value > 0 ? value : null, previous[1]] : [previous[0], Number.isFinite(value) && value > 0 ? value : null]); }} />}</div>
      </figure>;
      })}</div>
      {activePair[0].medium === 'video' && <div className={styles.videoControls}>
        <div className={styles.row}><button type="button" onClick={() => void play()} disabled={duration === null}>{playing ? '暂停两段' : '同步播放'}</button>
          <span>{secondsText(time)} / {duration !== null ? secondsText(duration) : '读取时长中'}</span>
          <label>声音<select value={audio} onChange={event => changeAudio(event.target.value as typeof audio)}><option value="none">静音</option><option value="left">{reversed ? '仅右侧' : '仅左侧'}</option><option value="right">{reversed ? '仅左侧' : '仅右侧'}</option></select></label>
          <label>速度<select value={rate} onChange={event => setRate(Number(event.target.value))}>{[0.5, 1, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select></label></div>
        {duration !== null && <input type="range" aria-label="两个视频的共同时间点" min="0" max={duration} step="0.01" value={Math.min(time, duration)} onChange={event => seek(Number(event.target.value))} />}
      </div>}
      <details className={styles.methodDifferences}><summary>设置差异{differences.length ? `（${differences.length}项）` : ''}</summary>
        <p className={styles.muted}>仅显示作品公开的设置记录。</p>
        <div className={styles.tableScroll}><table><thead><tr><th scope="col">设置</th><th scope="col">左侧</th><th scope="col">右侧</th></tr></thead><tbody>
          <tr><th scope="row">方法</th><td>{methods[columns[0]]?.label || '未提供'}</td><td>{methods[columns[1]]?.label || '未提供'}</td></tr>
          {(methods[0]?.template || methods[1]?.template) && <tr><th scope="row">模板版本</th>{columns.map(index => { const template = methods[index]?.template; return <td key={index}>{template ? `${template.label} · ${template.version}` : '未提供'}</td>; })}</tr>}
          {differences.map(item => <tr key={item.key}><th scope="row">{item.label}</th><td>{settingText(reversed ? item.right : item.left)}</td><td>{settingText(reversed ? item.left : item.right)}</td></tr>)}
        </tbody></table></div>
        {!differences.length && <p className={styles.muted}>公开记录中没有可比较的设置差异。</p>}
      </details>
    </>}
  </section>;
}
