'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Copy, Expand, Pencil, SlidersHorizontal, Lock, LockOpen } from 'lucide-react';
import { ProductActionMenu } from '@/components/ProductActionMenu';
import { createMultiviewFrameScrub, type MultiviewScrubSession } from './multiview-frame-scrub';
import styles from './multiview.module.css';

export function MultiviewFrameControls(props: {
  frame: number; name: string; index: number; timestamps: number[]; scope: string; disabled: boolean;
  locked?: boolean; onToggleLock: () => void;
  copying?: boolean; onCopy?: () => void;
  onBegin: () => MultiviewScrubSession | null;
  onUsage: (url: string, used: boolean) => void;
  onName: (anchor: HTMLElement) => void; onStep: (delta: -1 | 1) => void; onEdit: () => void; onZoom: () => void;
}) {
  const live = useRef(props); live.current = props;
  const [target, setTarget] = useState(props.frame);
  const [shown, setShown] = useState<{ frame: number; url: string } | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const gesture = useRef<ReturnType<typeof createMultiviewFrameScrub> | null>(null);
  const targetRef = useRef(props.frame);
  const raf = useRef<number>();
  const idle = useRef<ReturnType<typeof setTimeout>>();
  const pointer = useRef<number | null>(null);
  const cancelledPointer = useRef<number | null>(null);
  const keyboard = useRef(false);
  const cancelledKeyboard = useRef(false);
  const alive = useRef(true);
  function clearTimers() { if (raf.current !== undefined) cancelAnimationFrame(raf.current); clearTimeout(idle.current); raf.current = undefined; }
  function start() {
    if (gesture.current) return true;
    if (live.current.disabled || live.current.locked) return false;
    const session = live.current.onBegin(); if (!session) return false;
    setActive(true); setError('');
    gesture.current = createMultiviewFrameScrub(session,
      (frame, url) => { if (alive.current) setShown({ frame, url }); },
      message => {
        if (pointer.current !== null) cancelledPointer.current = pointer.current;
        if (keyboard.current) cancelledKeyboard.current = true;
        gesture.current = null; clearTimers(); pointer.current = null; keyboard.current = false;
        if (alive.current) { setActive(false); setShown(null); setTarget(live.current.frame); setError(message || ''); }
      });
    return true;
  }
  function change(frame: number) {
    if (cancelledPointer.current !== null || cancelledKeyboard.current) return;
    if (!start()) return;
    targetRef.current = frame; setTarget(frame);
    if (raf.current === undefined) raf.current = requestAnimationFrame(() => { raf.current = undefined; gesture.current?.target(targetRef.current); });
    if (pointer.current === null && !keyboard.current) {
      clearTimeout(idle.current); idle.current = setTimeout(() => finish(), 200);
    }
  }
  function finish() { clearTimers(); gesture.current?.finish(targetRef.current); }
  function cancel() {
    if (pointer.current !== null) cancelledPointer.current = pointer.current;
    if (keyboard.current) cancelledKeyboard.current = true;
    clearTimers(); gesture.current?.cancel(); pointer.current = null; keyboard.current = false;
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimers(); gesture.current?.cancel(); gesture.current = null; };
  }, []);
  useEffect(() => { cancel(); setShown(null); setTarget(props.frame); targetRef.current = props.frame;
    // A new scope invalidates responses even when React reuses the slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scope]);
  useEffect(() => { if (!gesture.current) { setTarget(props.frame); targetRef.current = props.frame; } }, [props.frame]);
  useEffect(() => {
    if (!shown) return;
    const usage = live.current.onUsage; usage(shown.url, true);
    return () => usage(shown.url, false);
  }, [shown]);
  const displayFrame = shown?.frame ?? props.frame;
  return <>
    <div className={styles.frameCorner} data-locked={props.locked || undefined} data-copying={props.copying || undefined} onPointerDown={event => event.stopPropagation()}>
      <button type="button" aria-label={props.locked ? '解锁此格' : '锁定此格'} title={props.locked ? '解锁此格' : '锁定此格'}
        aria-pressed={props.locked === true} disabled={props.disabled || active} onClick={props.onToggleLock}>{props.locked ? <Lock size={16} /> : <LockOpen size={16} />}</button>
      <button type="button" aria-label="放大原帧" title="放大原帧" disabled={props.disabled || active} onClick={props.onZoom}><Expand size={16} /></button>
      {props.onCopy && <button type="button" aria-label="复制原图" title={props.copying ? '正在复制原图' : '复制原图'} aria-busy={props.copying || undefined} disabled={props.disabled || active || props.copying} onClick={props.onCopy}><Copy size={16} /></button>}
    </div>
    {shown && <img className={styles.scrubImage} src={shown.url} alt={`第 ${props.index + 1} 张，第 ${displayFrame + 1} 帧`} />}
    <figcaption className={styles.frameFooter} onPointerDown={event => event.stopPropagation()} data-active={active || menuOpen || Boolean(error) || undefined} onKeyDown={event => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
    }}>
      <input type="range" className={styles.frameRange} min={0} max={Math.max(0, props.timestamps.length - 1)} step={1}
        value={target} disabled={props.disabled || props.locked || props.timestamps.length < 2}
        aria-label={`第 ${props.index + 1} 张快速选帧`}
        aria-valuetext={`第 ${target + 1} 帧，${props.timestamps[target]?.toFixed(3)} 秒`}
        title={props.timestamps.length < 2 ? '视频只有一帧' : '快速选帧'}
        onPointerDown={event => {
          cancelledPointer.current = null;
          if (!start()) return;
          pointer.current = event.pointerId; targetRef.current = Number(event.currentTarget.value);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={event => {
          if (cancelledPointer.current === event.pointerId) { cancelledPointer.current = null; return; }
          if (pointer.current !== event.pointerId) return;
          targetRef.current = Number(event.currentTarget.value); pointer.current = null; finish();
        }}
        onPointerCancel={() => { cancel(); cancelledPointer.current = null; }}
        onLostPointerCapture={event => {
          if (pointer.current === event.pointerId) cancel();
          if (cancelledPointer.current === event.pointerId) cancelledPointer.current = null;
        }}
        onChange={event => change(Number(event.target.value))}
        onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
            if (!event.repeat) cancelledKeyboard.current = false;
            if (cancelledKeyboard.current) { event.preventDefault(); return; }
            keyboard.current = true;
            if (event.key === 'PageUp' || event.key === 'PageDown') {
              event.preventDefault();
              change(Math.max(0, Math.min(props.timestamps.length - 1, targetRef.current + (event.key === 'PageUp' ? 10 : -10))));
            }
          }
        }}
        onKeyUp={event => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) && cancelledKeyboard.current) {
            cancelledKeyboard.current = false; return;
          }
          if (keyboard.current && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
            keyboard.current = false; finish();
          }
        }}
        onBlur={() => { if (pointer.current === null) finish(); }} />
      <div className={styles.frameActions}>
        <small title={props.name || `第 ${props.index + 1} 张`}>{props.name || `第 ${props.index + 1} 张`} · {displayFrame + 1}帧</small>
        <button type="button" disabled={props.disabled || active || props.frame === 0} title="前一帧" aria-label="前一帧" onClick={() => props.onStep(-1)}><ArrowLeft size={14} /></button>
        <button type="button" disabled={props.disabled || active || props.frame === props.timestamps.length - 1} title="后一帧" aria-label="后一帧" onClick={() => props.onStep(1)}><ArrowRight size={14} /></button>
        <ProductActionMenu label={`第 ${props.index + 1} 张操作`} disabled={props.disabled || active} onOpenChange={setMenuOpen} actions={[
          { id: 'frame', label: '精确换帧', icon: <SlidersHorizontal size={14} />, onSelect: props.onEdit },
          { id: 'name', label: '修改方向名称', icon: <Pencil size={14} />, onSelect: props.onName },
          { id: 'zoom', label: '放大原帧', icon: <Expand size={14} />, onSelect: props.onZoom },
        ]} />
      </div>
      {active && target !== displayFrame && <small>正在预览第 {target + 1} 帧</small>}
      {error && <small role="status">{error}</small>}
    </figcaption>
  </>;
}
