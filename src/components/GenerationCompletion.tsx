'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bell, Volume2 } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import styles from './GenerationCompletion.module.css';

type Kind = 'images' | 'avatar' | 'batch';
type Watch = { owner: string; id: string; kind: Kind; count: number; receipt: string };
type Preferences = { background: boolean; sound: boolean };
const jobs = new Map<string, Watch>();
const defaults: Preferences = { background: true, sound: false };
let owner: string | null = null, route = '', generation = 0, polling = false;
let audio: AudioContext | null = null;
let titleTimer: ReturnType<typeof setInterval> | null = null, originalTitle: string | null = null;
const prefKey = (id: string) => `sd2:completion:v1:${id}`;
const receiptKey = (id: string) => `${prefKey(id)}:completed`;
function preferences(id: string): Preferences {
  try { const value = JSON.parse(localStorage.getItem(prefKey(id)) || '{}'); return { background: value.background !== false, sound: value.sound === true }; } catch { return defaults; }
}
function clearTitle() {
  if (titleTimer) clearInterval(titleTimer);
  titleTimer = null;
  if (originalTitle !== null) document.title = originalTitle;
  originalTitle = null;
}
function completed(id: string): string[] {
  try { const value = JSON.parse(localStorage.getItem(receiptKey(id)) || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(-200) : []; } catch { return []; }
}
export function watchGenerationCompletion(ownerId: string, id: string, kind: Kind, count: number) {
  if (ownerId !== owner || jobs.size >= 32 || !/^[a-zA-Z0-9-]{1,100}$/.test(id) || count < 1 || count > 100) return;
  const receipt = `${kind}:${id}`;
  if (!completed(ownerId).includes(receipt)) jobs.set(receipt, { owner: ownerId, id, kind, count, receipt });
}
function notify(success: boolean, prefs: Preferences) {
  if (prefs.background && document.hidden) {
    clearTitle(); originalTitle = document.title;
    const text = success ? '已完成' : '生成已结束';
    const steady = () => { if (originalTitle !== null) document.title = `${text} · ${originalTitle}`; };
    steady();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const started = Date.now(); let turn = 0;
      titleTimer = setInterval(() => {
        if (!document.hidden) { clearTitle(); return; }
        if (Date.now() - started >= 6000 || ++turn >= 6) { if (titleTimer) clearInterval(titleTimer); titleTimer = null; steady(); return; }
        document.title = turn % 2 ? originalTitle! : `${text} · ${originalTitle}`;
      }, 1000);
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
  try {
    for (const job of Array.from(jobs.values()).slice(0, 32)) {
      if (owner !== expectedOwner || generation !== expectedGeneration) break;
      try {
        const query = job.kind === 'batch' ? `/api/image-studio/batches?id=${job.id}` : job.kind === 'avatar' ? `/api/avatar-studio?plan=${job.id}` : `/api/image-studio/tasks?requestId=${job.id}`;
        const response = await fetch(query, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        if (!response.ok) continue;
        const data = await response.json();
        if (owner !== expectedOwner || generation !== expectedGeneration) break;
        let terminal = false, success = false;
        if (job.kind === 'batch') {
          const batch = data.batch;
          terminal = batch && ['complete', 'cancelled'].includes(batch.state) && batch.active === 0 && batch.pending === 0;
          success = terminal && batch.generated === batch.total && batch.failed === 0 && batch.uncertain === 0;
        } else {
          const tasks = data.tasks;
          terminal = Array.isArray(tasks) && tasks.length === job.count && tasks.every(task => ['succeeded', 'failed', 'uncertain'].includes(task.status));
          success = terminal && tasks.every((task: { status: string }) => task.status === 'succeeded');
        }
        if (!terminal) continue;
        jobs.delete(job.receipt);
        const deliver = () => {
          if (owner !== job.owner || generation !== expectedGeneration || completed(job.owner).includes(job.receipt)) return;
          try { localStorage.setItem(receiptKey(job.owner), JSON.stringify([...completed(job.owner), job.receipt].slice(-200))); } catch { /* In-memory watch deletion still prevents repeated polls. */ }
          notify(success, preferences(job.owner));
        };
        if (navigator.locks) await navigator.locks.request(`sd2-completion:${job.owner}`, deliver); else deliver();
      } catch { /* Observation failures never imply completion or replay generation. */ }
    }
  } finally { polling = false; }
}
export function GenerationCompletionRuntime() {
  const { user } = useAppSession(); const pathname = usePathname();
  useEffect(() => {
    if (owner !== (user?.id || null) || route !== pathname) { generation++; jobs.clear(); clearTitle(); }
    if (owner !== (user?.id || null) && audio) { void audio.close(); audio = null; }
    owner = user?.id || null; route = pathname;
    const visible = () => { if (!document.hidden) { clearTitle(); void poll(); } };
    let timer: ReturnType<typeof setTimeout>, active = true;
    const schedule = () => { if (active) timer = setTimeout(() => { void poll().finally(schedule); }, document.hidden ? 15000 : 5000); };
    schedule(); document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); generation++; jobs.clear(); clearTitle(); };
  }, [user?.id, pathname]);
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
    <small>只提醒本页发起的生成；关闭网页或手机锁屏后不保证提醒。</small>{message && <p role="status">{message}</p>}
  </details>;
}
