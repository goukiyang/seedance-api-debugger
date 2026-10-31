'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, Volume2 } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import styles from './GenerationCompletion.module.css';
import { revalidateActiveImages, setImageReadSessionOwner } from '@/lib/media/image-read-session';
import { getPageExitRisk } from '@/lib/hooks/page-exit-guard';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { acknowledgeGenerationCompletion, completionCardIsVisible, generationCompletionHref, observeGenerationCompletion,
  type GenerationCompletionKind, type GenerationCompletionHint, type GenerationCompletionWatch, type GenerationCompletionTarget,
  type GenerationCompletionRequest } from '@/lib/generation-completion';

type Preferences = { background: boolean; sound: boolean };
const jobs = new Map<string, GenerationCompletionWatch & { observed: Set<string> }>();
const unseen = new Map<string, GenerationCompletionTarget>();
const memoryReceipts = new Set<string>();
const defaults: Preferences = { background: true, sound: false };
const stateEvent = 'sd2:completion-state';
let owner: string | null = null, generation = 0, polling = false;
let requested: GenerationCompletionRequest | null = null, requestSequence = 0, landingMessage = '';
let audio: AudioContext | null = null;
let favicon: typeof import('magic-favicon')['default'] | null = null;
let faviconLoading: Promise<typeof import('magic-favicon')['default']> | null = null;
let pulseTimer: ReturnType<typeof setTimeout> | null = null, indicatorRevision = 0;
let originalTitle: string | null = null, noticeTitle: string | null = null, attentionStarted = 0;
const prefKey = (id: string) => `sd2:completion:v1:${id}`;
const receiptKey = (id: string) => `${prefKey(id)}:completed`;
const changed = () => window.dispatchEvent(new Event(stateEvent));
function preferences(id: string): Preferences {
  try { const value = JSON.parse(localStorage.getItem(prefKey(id)) || '{}'); return { background: value.background !== false, sound: value.sound === true }; } catch { return defaults; }
}
function clearAttention() {
  indicatorRevision++;
  if (pulseTimer) clearTimeout(pulseTimer);
  pulseTimer = null;
  const restore = originalTitle, applied = noticeTitle;
  originalTitle = null; noticeTitle = null; attentionStarted = 0;
  if (restore !== null && document.title === applied) document.title = restore;
  favicon?.reset(); favicon?.destroy();
}
async function refreshAttention(pulse = false) {
  const currentOwner = owner, revision = indicatorRevision, count = unseen.size;
  if (!currentOwner || !count || !preferences(currentOwner).background) { clearAttention(); return; }
  if (!document.hidden && originalTitle === null) return;
  const first = originalTitle === null;
  if (first) { originalTitle = document.title; attentionStarted = Date.now(); }
  noticeTitle = `生成完成${count > 1 ? `（${count}）` : ''}`;
  document.title = noticeTitle;
  try {
    // The package's singleton touches document while evaluating its module.
    faviconLoading ??= import('magic-favicon').then(module => { favicon = module.default; return favicon; });
    const icon = await faviconLoading;
    if (owner !== currentOwner || revision !== indicatorRevision || !unseen.size || !preferences(currentOwner).background) return;
    const remaining = 8000 - (Date.now() - attentionStarted);
    if (first && pulse && remaining > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      try { icon.pulse({ color: '#79daca', periodMs: 1800, tickMs: 160, preserveBase: true, sizeRatio: 0.8 }); }
      catch { icon.reset(); icon.badge(unseen.size, { bgColor: '#278c73', preserveBase: true }); return; }
      pulseTimer = setTimeout(() => {
        pulseTimer = null;
        if (owner === currentOwner && revision === indicatorRevision && unseen.size) icon.badge(unseen.size, { bgColor: '#278c73', preserveBase: true });
      }, remaining);
    } else if (!pulseTimer) icon.badge(unseen.size, { bgColor: '#278c73', preserveBase: true });
  } catch { /* The title and the in-app result entry remain available if the favicon cannot load. */ }
}
function completed(id: string): string[] {
  const memory = Array.from(memoryReceipts).filter(item => item.startsWith(`${id}:`)).map(item => item.slice(id.length + 1));
  try { const value = JSON.parse(localStorage.getItem(receiptKey(id)) || '[]'); return Array.from(new Set([...memory, ...(Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(-200) : [])])); } catch { return memory; }
}
export function watchGenerationCompletion(ownerId: string, id: string, kind: GenerationCompletionKind, count: number, operationId?: string, baselineSuccess = 0, hint?: GenerationCompletionHint) {
  if (ownerId !== owner || jobs.size >= 32 || !/^[a-zA-Z0-9-]{1,100}$/.test(id) || count < 1 || count > 100) return;
  if (operationId && !/^[a-zA-Z0-9-]{1,100}$/.test(operationId)) return;
  const receipt = `${kind}:${id}${operationId ? `:${operationId}` : ''}`;
  if (operationId) for (const job of Array.from(jobs.values())) if (job.owner === ownerId && job.id === id && job.kind === kind) jobs.delete(job.receipt);
  if (!completed(ownerId).includes(receipt)) jobs.set(receipt, { owner: ownerId, id, kind, count, receipt, baselineSuccess, hint, observed: new Set() });
}
export function useGenerationCompletionTarget(ownerId: string) {
  const [, update] = useState(0);
  useEffect(() => { const read = () => update(value => value + 1); window.addEventListener(stateEvent, read); return () => window.removeEventListener(stateEvent, read); }, []);
  return requested?.owner === ownerId ? requested : null;
}
function sound(success: boolean, prefs: Preferences) {
  if (prefs.sound && audio?.state === 'running') {
    const oscillator = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(success ? 660 : 440, now);
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.08, now + 0.03); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(now); oscillator.stop(now + 0.4);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
}
async function poll() {
  if (polling || !owner || !jobs.size || isClientSessionBlocked()) return;
  polling = true; const expectedOwner = owner, expectedGeneration = generation;
  let successes = 0, failures = 0;
  try {
    for (const job of Array.from(jobs.values()).slice(0, 32)) {
      if (owner !== expectedOwner || generation !== expectedGeneration || isClientSessionBlocked()) break;
      jobs.delete(job.receipt); jobs.set(job.receipt, job);
      try {
        const query = job.kind === 'batch' ? `/api/image-studio/batches?id=${job.id}` : job.kind === 'avatar' ? `/api/avatar-studio?plan=${job.id}` : `/api/image-studio/tasks?requestId=${job.id}&projection=studio-task-summary-v1`;
        const response = await fetch(query, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        if (!response.ok) continue;
        const data = await response.json();
        if (owner !== expectedOwner || generation !== expectedGeneration || isClientSessionBlocked()) break;
        const observation = observeGenerationCompletion(job, data);
        if (!observation.terminal && !observation.targets.length) continue;
        if (observation.terminal) jobs.delete(job.receipt);
        const deliver = () => {
          if (owner !== job.owner || generation !== expectedGeneration || completed(job.owner).includes(job.receipt)) return;
          const old = new Set(completed(job.owner));
          const fresh = observation.targets.filter(target => !old.has(target.key) && !job.observed.has(target.key));
          for (const target of fresh) { job.observed.add(target.key); unseen.set(target.key, target); old.add(target.key); memoryReceipts.add(`${job.owner}:${target.key}`); }
          if (observation.terminal) { old.add(job.receipt); memoryReceipts.add(`${job.owner}:${job.receipt}`); }
          while (memoryReceipts.size > 200) memoryReceipts.delete(memoryReceipts.values().next().value!);
          try { localStorage.setItem(receiptKey(job.owner), JSON.stringify(Array.from(old).slice(-200))); } catch { /* The in-memory receipt and deleted watch still prevent another poll. */ }
          if (fresh.length) successes += fresh.length; else if (observation.terminal && !observation.success && !observation.targets.length) failures++;
        };
        if (navigator.locks) await navigator.locks.request(`sd2-completion:${job.owner}`, deliver); else deliver();
      } catch { /* Observation failures never imply completion or replay generation. */ }
    }
    if (owner === expectedOwner && generation === expectedGeneration) {
      if (successes) { landingMessage = ''; changed(); void refreshAttention(true); sound(true, preferences(expectedOwner)); }
      else if (failures) sound(false, preferences(expectedOwner));
    }
  } finally { polling = false; }
}
export function GenerationCompletionRuntime() {
  const { user, hasLoadedUser, userLoadError } = useAppSession();
  const pathname = usePathname(), router = useRouter();
  const [, update] = useState(0);
  useEffect(() => { setImageReadSessionOwner(hasLoadedUser && !userLoadError ? `${user?.id || 'anonymous'}:${user?.role || ''}:${user?.account_type || ''}` : ''); }, [user?.id, user?.role, user?.account_type, hasLoadedUser, userLoadError]);
  function openResult(target: GenerationCompletionTarget, automatic = false) {
    if (target.owner !== owner || !unseen.has(target.key) || isClientSessionBlocked()) return;
    const href = generationCompletionHref(target);
    if (window.location.pathname + window.location.search !== href) {
      const risk = getPageExitRisk();
      if (risk.busy.length || risk.unsaved.length) { landingMessage = '当前编辑或操作尚未结束，请处理后查看结果'; changed(); return; }
    }
    requested = { ...target, requestId: ++requestSequence, automatic }; landingMessage = ''; changed();
    router.push(href, { scroll: false });
  }
  useEffect(() => {
    const confirmedOwner = hasLoadedUser && !userLoadError ? user?.id || null : null;
    if (owner !== confirmedOwner) { generation++; jobs.clear(); unseen.clear(); requested = null; landingMessage = ''; clearAttention(); }
    if (owner !== confirmedOwner && audio) { void audio.close(); audio = null; }
    owner = confirmedOwner;
    let active = true, wasHidden = document.visibilityState === 'hidden', interaction = 0;
    const interacted = (event: Event) => {
      interaction++;
      if (requested?.automatic && !(event.target as Element | null)?.closest?.('[data-completion-notice]')) { requested = null; landingMessage = ''; changed(); }
    };
    const stateChanged = () => update(value => value + 1);
    const visible = () => {
      const returning = wasHidden && document.visibilityState === 'visible';
      wasHidden = document.visibilityState === 'hidden';
      if (document.visibilityState !== 'visible') { void refreshAttention(false); return; }
      revalidateActiveImages(60000);
      const atReturn = interaction, expected = generation;
      let opened = Boolean(requested);
      if (returning && owner && preferences(owner).background && unseen.size && !requested) { openResult(unseen.values().next().value!, true); opened = true; }
      void poll().then(() => {
        if (active && returning && !opened && interaction === atReturn && generation === expected && document.visibilityState === 'visible'
          && owner && preferences(owner).background && unseen.size && !requested) openResult(unseen.values().next().value!, true);
      });
    };
    const preferenceChanged = (event: StorageEvent) => { if (owner && event.key === prefKey(owner)) void refreshAttention(false); };
    const titleObserver = new MutationObserver(() => {
      if (noticeTitle && unseen.size && document.title !== noticeTitle) { originalTitle = document.title; document.title = noticeTitle; }
    });
    titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { if (active) timer = setTimeout(() => { if (!document.hidden) revalidateActiveImages(60000); void poll().finally(schedule); }, document.hidden ? 15000 : 5000); };
    schedule(); document.addEventListener('visibilitychange', visible); window.addEventListener('storage', preferenceChanged); window.addEventListener(stateEvent, stateChanged);
    window.addEventListener('pointerdown', interacted, true); window.addEventListener('keydown', interacted, true);
    return () => {
      active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('storage', preferenceChanged);
      window.removeEventListener(stateEvent, stateChanged); window.removeEventListener('pointerdown', interacted, true); window.removeEventListener('keydown', interacted, true);
      titleObserver.disconnect(); generation++; jobs.clear(); unseen.clear(); requested = null; clearAttention();
    };
    // The account owns the observers; navigation must not discard unseen results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, hasLoadedUser, userLoadError]);
  useEffect(() => { void refreshAttention(false); }, [pathname]);
  const request = requested?.owner === user?.id ? requested : null;
  useEffect(() => {
    if (!request) return;
    let active = true, card: HTMLElement | null = null, highlighting = false, scrolled = false;
    let highlightTimer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;
    const expectedGeneration = generation;
    const valid = () => active && !isClientSessionBlocked() && generation === expectedGeneration && owner === request.owner && requested?.requestId === request.requestId;
    const finish = () => {
      if (!valid() || !card || !completionCardIsVisible(card)) return;
      const rect = card.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return;
      if (acknowledgeGenerationCompletion(unseen, owner, request.key, card.dataset.resultTaskId || '')) {
        requested = null; landingMessage = ''; changed(); void refreshAttention(false);
      }
    };
    const locate = () => {
      if (!valid() || document.visibilityState !== 'visible') return;
      card ??= Array.from(document.querySelectorAll<HTMLElement>('[data-result-task-id][data-result-ready]'))
        .find(element => element.dataset.resultTaskId === request.taskId && completionCardIsVisible(element)) || null;
      if (!card || !completionCardIsVisible(card)) { card = null; scrolled = false; return; }
      if (!scrolled) { scrolled = true; card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); }
      const rect = card.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) { frame = requestAnimationFrame(locate); return; }
      if (highlighting) return;
      highlighting = true;
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) card.animate?.([{ boxShadow: '0 0 0 3px #79daca' }, { boxShadow: '0 0 0 3px transparent' }], { duration: 1400, easing: 'ease-out' });
      highlightTimer = setTimeout(finish, 1400);
    };
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-result-ready', 'data-result-task-id', 'hidden', 'aria-hidden', 'class', 'style', 'open'] });
    locate();
    const deadline = setTimeout(() => {
      if (!valid()) return;
      requested = null; landingMessage = '结果暂未定位，请再次查看'; changed();
    }, 30000);
    return () => { active = false; observer.disconnect(); clearTimeout(deadline); if (highlightTimer) clearTimeout(highlightTimer); cancelAnimationFrame(frame); };
  }, [request?.requestId]);
  const pending = user?.id === owner ? Array.from(unseen.values()) : [];
  return pending.length ? <aside data-completion-notice className={styles.completionNotice} role="status" aria-live="polite">
    <span>生成完成{pending.length > 1 ? `（${pending.length}）` : ''}</span><span aria-hidden="true">·</span>
    <button type="button" disabled={Boolean(request)} onClick={() => openResult(pending[0])}>{request ? '正在定位结果' : '查看结果'}</button>
    {landingMessage && <small>{landingMessage}</small>}
  </aside> : null;
}
export function GenerationCompletionSettings({ ownerId }: { ownerId: string }) {
  const [prefs, setPrefs] = useState(defaults), [audioReady, setAudioReady] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { setPrefs(preferences(ownerId)); setAudioReady(audio?.state === 'running'); setMessage(''); }, [ownerId]);
  function save(next: Preferences) { setPrefs(next); try { localStorage.setItem(prefKey(ownerId), JSON.stringify(next)); } catch { setMessage('本机未能记住提醒设置'); } void refreshAttention(false); }
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
