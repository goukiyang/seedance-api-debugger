'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useDialogDismiss } from './useDialogDismiss';
import styles from './RelativeTime.module.css';

const listeners = new Set<() => void>();
let clock = 0;
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    clock = Date.now();
    timer = setInterval(() => {
      if (document.hidden) return;
      clock = Date.now(); listeners.forEach(notify => notify());
    }, 30_000);
  }
  return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
}
const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'always' });
export function relativeTimeText(value: string, now: number) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '时间待同步';
  const delta = timestamp - now;
  const distance = Math.abs(delta);
  if (distance < 45_000) return delta <= 0 ? '刚刚' : '即将';
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 86_400_000], ['month', 30 * 86_400_000], ['week', 7 * 86_400_000],
    ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000],
  ];
  const [unit, duration] = units.find(([, span]) => distance >= span) || units[units.length - 1];
  return formatter.format(Math.sign(delta) * Math.max(1, Math.floor(distance / duration)), unit);
}

export function RelativeTime({ value, className }: { value: string; className?: string }) {
  const now = useSyncExternalStore(subscribe, () => clock, () => 0);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const pinned = useRef(false);
  const hovered = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const timestamp = Date.parse(value);
  const valid = Number.isFinite(timestamp);
  const absolute = valid ? new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'shortOffset',
  }).format(timestamp) : '时间待同步';
  function close() { pinned.current = false; setOpen(false); }
  useDialogDismiss({ open, dialogRef: bubble, branchRefs: [trigger], modal: false, restoreFocus: false, onDismiss: close });
  function reveal(pin = false) {
    if (!valid) return;
    window.dispatchEvent(new CustomEvent('sd2-time-bubble', { detail: id }));
    pinned.current = pin;
    setContainer(trigger.current?.closest<HTMLDialogElement>('dialog[open]') || document.body);
    setOpen(true);
  }
  useEffect(() => {
    const other = (event: Event) => { if ((event as CustomEvent).detail !== id) close(); };
    window.addEventListener('sd2-time-bubble', other);
    return () => window.removeEventListener('sd2-time-bubble', other);
  }, [id]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = bubble.current?.offsetWidth || 260;
      const height = bubble.current?.offsetHeight || 32;
      setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        top: anchor.top >= height + 14 ? anchor.top - height - 6 : Math.min(anchor.bottom + 6, window.innerHeight - height - 8) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
    };
  }, [open, absolute]);
  const unhover = () => {
    hovered.current = false;
    if (!pinned.current && document.activeElement !== trigger.current) setOpen(false);
  };
  return <>
    <button ref={trigger} type="button" className={`${styles.trigger} ${className || ''}`} disabled={!valid}
      aria-label={`查看准确时间：${absolute}`} aria-describedby={open ? id : undefined}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); if (pinned.current) close(); else reveal(true); }}
      onMouseEnter={() => { hovered.current = true; if (!pinned.current) reveal(); }} onMouseLeave={unhover}
      onFocus={() => { if (!pinned.current) reveal(); }} onBlur={() => { if (!pinned.current && !hovered.current) setOpen(false); }}>
      <time dateTime={valid ? new Date(timestamp).toISOString() : undefined} suppressHydrationWarning>{now ? relativeTimeText(value, now) : absolute}</time>
    </button>
    {open && container && createPortal(<span ref={bubble} id={id} role="tooltip" className={styles.bubble} style={position}
      onMouseEnter={() => { hovered.current = true; }} onMouseLeave={unhover}>{absolute}</span>, container)}
  </>;
}
