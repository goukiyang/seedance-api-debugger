'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bell, Volume2 } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import styles from './GenerationCompletion.module.css';
import { revalidateActiveImages, setImageReadSessionOwner } from '@/lib/media/image-read-session';

type Kind = 'images' | 'avatar' | 'batch';
type Watch = { owner: string; id: string; kind: Kind; count: number; receipt: string; baselineSuccess: number };
type Preferences = { background: boolean; sound: boolean };
const jobs = new Map<string, Watch>();
const memoryReceipts = new Set<string>();
const defaults: Preferences = { background: true, sound: false };
let owner: string | null = null, generation = 0, polling = false;
let audio: AudioContext | null = null;
let titleTimer: ReturnType<typeof setInterval> | null = null, originalTitle: string | null = null;
let noticeTitle: string | null = null, noticeExpires = 0, noticeCount = 0;
const prefKey = (id: string) => `sd2:completion:v1:${id}`;
const receiptKey = (id: string) => `${prefKey(id)}:completed`;
function preferences(id: string): Preferences {
  try { const value = JSON.parse(localStorage.getItem(prefKey(id)) || '{}'); return { background: value.background !== false, sound: value.sound === true }; } catch { return defaults; }
}
function clearTitle() {
  if (titleTimer) clearInterval(titleTimer);
  titleTimer = null;
  if (originalTitle !== null && (document.title === noticeTitle || document.title === originalTitle)) document.title = originalTitle;
  originalTitle = null; noticeTitle = null; noticeExpires = 0; noticeCount = 0;
}
function completed(id: string): string[] {
  const memory = Array.from(memoryReceipts).filter(item => item.startsWith(`${id}:`)).map(item => item.slice(id.length + 1));
  try { const value = JSON.parse(localStorage.getItem(receiptKey(id)) || '[]'); return Array.from(new Set([...memory, ...(Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(-200) : [])])); } catch { return memory; }
}
export function watchGenerationCompletion(ownerId: string, id: string, kind: Kind, count: number, operationId?: string, baselineSuccess = 0) {
  if (ownerId !== owner || jobs.size >= 32 || !/^[a-zA-Z0-9-]{1,100}$/.test(id) || count < 1 || count > 100) return;
  if (operationId && !/^[a-zA-Z0-9-]{1,100}$/.test(operationId)) return;
  const receipt = `${kind}:${id}${operationId ? `:${operationId}` : ''}`;
  if (operationId) for (const job of Array.from(jobs.values())) {
    if (job.owner === ownerId && job.id === id && job.kind === kind) jobs.delete(job.receipt);
  }
  if (!completed(ownerId).includes(receipt)) jobs.set(receipt, { owner: ownerId, id, kind, count, receipt, baselineSuccess });
}
function notify(success: boolean, prefs: Preferences, count = 1) {
  if (success && prefs.background && document.hidden) {
    if (originalTitle === null) { originalTitle = document.title; noticeExpires = Date.now() + 8000; }
    noticeCount += count;
    noticeTitle = `${noticeCount > 1 ? `${noticeCount}批` : '图片'}已完成 · ${originalTitle}`;
    document.title = noticeTitle;
    if (!titleTimer) {
      let turn = 0;
      titleTimer = setInterval(() => {
        if (!document.hidden || !owner || !preferences(owner).background) { clearTitle(); return; }
        if (Date.now() >= noticeExpires) { if (titleTimer) clearInterval(titleTimer); titleTimer = null; document.title = noticeTitle!; return; }
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) document.title = ++turn % 2 ? originalTitle! : noticeTitle!;
      }, 1400);
    }
  }
  if (prefs.sound && audio?.state === 'running') {
    const oscillator = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(success ? 660 : 440, now);
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.08, now + 0.03); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(now); oscillator.stop(now + 0.4);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
}
async function poll() {
  if (polling || !owner || !jobs.size) return;
  polling = true; const expectedOwner = owner, expectedGeneration = generation;
  let successes = 0, failures = 0;
  try {
    for (const job of Array.from(jobs.values()).slice(0, 32)) {
      if (owner !== expectedOwner || generation !== expectedGeneration) break;
      try {
        const query = job.kind === 'batch' ? `/api/image-studio/batches?id=${job.id}` : job.kind === 'avatar' ? `/api/avatar-studio?plan=${job.id}` : `/api/image-studio/tasks?requestId=${job.id}`;
        const response = await fetch(query, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        if (!response.ok) continue;
        const data = await response.json();
        if (owner !== expectedOwner || generation !== expectedGeneration) break;
        let terminal = false, success = false, hasNewImage = false;
        if (job.kind === 'batch') {
          const batch = data.batch;
          terminal = batch && ['complete', 'cancelled'].includes(batch.state) && batch.active === 0 && batch.pending === 0 && batch.uncertain === 0;
          success = terminal && batch.generated === batch.total && batch.failed === 0 && batch.uncertain === 0;
          hasNewImage = terminal && batch.generated > job.baselineSuccess;
        } else {
          const tasks = data.tasks;
          terminal = Array.isArray(tasks) && tasks.length === job.count && tasks.every(task => ['succeeded', 'failed'].includes(task.status));
          success = terminal && tasks.every((task: { status: string }) => task.status === 'succeeded');
          hasNewImage = terminal && tasks.some((task: { status: string }) => task.status === 'succeeded');
        }
        if (!terminal) continue;
        jobs.delete(job.receipt);
        const deliver = () => {
          if (owner !== job.owner || generation !== expectedGeneration || completed(job.owner).includes(job.receipt)) return;
          memoryReceipts.add(`${job.owner}:${job.receipt}`);
          if (memoryReceipts.size > 200) memoryReceipts.delete(memoryReceipts.values().next().value!);
          try { localStorage.setItem(receiptKey(job.owner), JSON.stringify(Array.from(new Set([...completed(job.owner), job.receipt])).slice(-200))); } catch { /* In-memory watch deletion still prevents repeated polls. */ }
          if (hasNewImage) successes++; else if (!success) failures++;
        };
        if (navigator.locks) await navigator.locks.request(`sd2-completion:${job.owner}`, deliver); else deliver();
      } catch { /* Observation failures never imply completion or replay generation. */ }
    }
    if (owner === expectedOwner && generation === expectedGeneration) {
      if (successes) notify(true, preferences(expectedOwner), successes);
      else if (failures) notify(false, preferences(expectedOwner));
    }
  } finally { polling = false; }
}
export function GenerationCompletionRuntime() {
  const { user, hasLoadedUser, userLoadError } = useAppSession(); const pathname = usePathname();
  useEffect(() => { setImageReadSessionOwner(hasLoadedUser && !userLoadError ? `${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}` : ''); }, [user?.id, user?.role, user?.account_type, hasLoadedUser, userLoadError]);
  useEffect(() => {
    const confirmedOwner = hasLoadedUser && !userLoadError ? user?.id || null : null;
    if (owner !== confirmedOwner) { generation++; jobs.clear(); clearTitle(); }
    if (owner !== confirmedOwner && audio) { void audio.close(); audio = null; }
    owner = confirmedOwner;
    const visible = () => { revalidateActiveImages(60000); if (!document.hidden) { clearTitle(); void poll(); } };
    const changed = (event: StorageEvent) => { if (owner && event.key === prefKey(owner) && !preferences(owner).background) clearTitle(); };
    let timer: ReturnType<typeof setTimeout>, active = true;
    const schedule = () => { if (active) timer = setTimeout(() => { if (!document.hidden) revalidateActiveImages(60000); void poll().finally(schedule); }, document.hidden ? 15000 : 5000); };
    schedule(); document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible); window.addEventListener('storage', changed);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); window.removeEventListener('storage', changed); generation++; jobs.clear(); clearTitle(); };
  }, [user?.id, hasLoadedUser, userLoadError]);
  useEffect(() => { clearTitle(); }, [pathname]);
  return null;
}
export function GenerationCompletionSettings({ ownerId }: { ownerId: string }) {
  const [prefs, setPrefs] = useState(defaults), [audioReady, setAudioReady] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { setPrefs(preferences(ownerId)); setAudioReady(audio?.state === 'running'); setMessage(''); }, [ownerId]);
  function save(next: Preferences) { setPrefs(next); try { localStorage.setItem(prefKey(ownerId), JSON.stringify(next)); } catch { setMessage('本机未能记住提醒设置'); } if (!next.background) clearTitle(); }
  async function enableSound() {
    try {
      if (!audio || audio.state === 'closed') audio = new AudioContext();
      await audio.resume(); const ready = audio.state === 'running'; setAudioReady(ready);
      save({ ...prefs, sound: ready }); setMessage(ready ? '提示音已启用' : '浏览器尚未允许声音，请再次点击启用');
    } catch { setAudioReady(false); setMessage('浏览器尚未允许声音，请再次点击启用'); }
  }
  return <details className={styles.settings}><summary><Bell size={15} aria-hidden="true" />完成提醒</summary>
    <label><input type="checkbox" checked={prefs.background} onChange={event => save({ ...prefs, background: event.target.checked })} />后台标签提醒</label>
    <label><input type="checkbox" checked={prefs.sound} onChange={event => event.target.checked ? void enableSound() : save({ ...prefs, sound: false })} />提示音</label>
    {prefs.sound && (!audioReady || audio?.state !== 'running') && <button type="button" onClick={() => void enableSound()}><Volume2 size={15} />解锁提示音</button>}
    <small>只提醒本次打开网站后发起的生成；关闭网页或手机锁屏后不保证提醒。</small>{message && <p role="status">{message}</p>}
  </details>;
}
