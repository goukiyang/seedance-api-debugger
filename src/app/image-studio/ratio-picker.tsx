'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Info, Trash2, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { resolveStudioAspectRatio, normalizeStudioRatio, STUDIO_RATIOS } from '@/lib/image-studio/ratios';
import { imageOutputSize } from '@/lib/image-generation/resolution';
import styles from './studio.module.css';

export function RatioPicker({ value, onChange, reference, model, resolution, custom, busy, disabled, error, onRetry, onCustom, onEditing }: {
  value: string; onChange: (ratio: string) => void; reference?: { width?: unknown; height?: unknown } | null; model: string; resolution: string; custom: string[]; busy: boolean; disabled: boolean; error: string;
  onRetry: () => void; onCustom: (ratio: string, remove: boolean) => Promise<boolean>; onEditing: (editing: boolean) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [placement, setPlacement] = useState({ above: false, height: 420, width: 0, left: 0 });
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const [validation, setValidation] = useState('');
  const saving = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const infoButton = useRef<HTMLButtonElement>(null);
  const info = useRef<HTMLParagraphElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useDialogDismiss({ open: menuOpen, dialogRef: menu, branchRefs: [trigger], modal: false, restoreFocus: !other && !showInfo, onDismiss: () => setMenuOpen(false) });
  useDialogDismiss({ open: showInfo && !other, dialogRef: info, branchRefs: [infoButton], modal: false, restoreFocus: false, onDismiss: () => setShowInfo(false) });
  useEffect(() => { onEditing(other); }, [other, onEditing]);
  useEffect(() => {
    if (!other) return;
    // Focus the custom editor after the popover closes.
    const frame = window.requestAnimationFrame(() => input.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [other]);
  useEffect(() => {
    if (!menuOpen) return;
    const selected = menu.current?.querySelector<HTMLButtonElement>('[data-ratio-option][aria-pressed="true"]')
      || menu.current?.querySelector<HTMLButtonElement>('[data-ratio-option]');
    selected?.focus({ preventScroll: true });
    if (selected && menu.current) {
      const optionBounds = selected.getBoundingClientRect(), menuBounds = menu.current.getBoundingClientRect();
      if (optionBounds.bottom > menuBounds.bottom - 10) menu.current.scrollTop += optionBounds.bottom - menuBounds.bottom + 10;
    }
  }, [menuOpen]);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const ancestors: HTMLElement[] = [];
    for (let ancestor = trigger.current?.parentElement; ancestor; ancestor = ancestor.parentElement) ancestors.push(ancestor);
    const clips = (overflow: string) => /^(auto|scroll|hidden|clip|overlay)$/.test(overflow);
    const position = () => {
      if (!trigger.current || !menu.current) return;
      const bounds = trigger.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop || 0, left = viewport?.offsetLeft || 0;
      const height = viewport?.height || window.innerHeight, width = viewport?.width || window.innerWidth;
      let visibleTop = top, visibleLeft = left, visibleBottom = top + height, visibleRight = left + width;
      // The native settings dialog and other scroll containers clip in their own client boxes.
      for (const ancestor of ancestors) {
        // Root overflow clips the viewport, not the root's scrolled document rectangle.
        // Combining rect.top (-scrollY) with clientHeight (viewport height) would close
        // a perfectly visible picker as soon as it opens further down the page.
        if (ancestor === document.documentElement || ancestor === document.scrollingElement) continue;
        const style = window.getComputedStyle(ancestor);
        const clipX = clips(style.overflowX), clipY = clips(style.overflowY);
        if (!clipX && !clipY) continue;
        const rect = ancestor.getBoundingClientRect();
        const scaleX = ancestor.offsetWidth ? rect.width / ancestor.offsetWidth : 1;
        const scaleY = ancestor.offsetHeight ? rect.height / ancestor.offsetHeight : 1;
        const clientLeft = rect.left + ancestor.clientLeft * scaleX;
        const clientTop = rect.top + ancestor.clientTop * scaleY;
        if (clipX) {
          visibleLeft = Math.max(visibleLeft, clientLeft);
          visibleRight = Math.min(visibleRight, clientLeft + ancestor.clientWidth * scaleX);
        }
        if (clipY) {
          visibleTop = Math.max(visibleTop, clientTop);
          visibleBottom = Math.min(visibleBottom, clientTop + ancestor.clientHeight * scaleY);
        }
      }
      if (bounds.bottom <= visibleTop || bounds.top >= visibleBottom || bounds.right <= visibleLeft || bounds.left >= visibleRight) {
        setMenuOpen(false);
        return;
      }
      const below = Math.max(0, visibleBottom - bounds.bottom - 18);
      const above = Math.max(0, bounds.top - visibleTop - 18);
      const flipped = below < Math.min(menu.current.scrollHeight, 300) && above > below;
      const menuWidth = Math.min(bounds.width, Math.max(0, visibleRight - visibleLeft - 24));
      const menuLeft = Math.max(visibleLeft + 12, Math.min(bounds.left, visibleRight - menuWidth - 12));
      setPlacement({ above: flipped, height: Math.min(420, flipped ? above : below), width: menuWidth, left: menuLeft - bounds.left });
    };
    position();
    const observer = new ResizeObserver(position);
    if (trigger.current) observer.observe(trigger.current);
    for (const ancestor of ancestors) {
      const style = window.getComputedStyle(ancestor);
      if (clips(style.overflowX) || clips(style.overflowY)) observer.observe(ancestor);
    }
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [menuOpen]);
  function select(ratio: string) {
    onChange(ratio); setOther(false); setValidation(''); setMenuOpen(false);
    trigger.current?.focus({ preventScroll: true });
    // Custom saving may still have the trigger disabled until the state update commits.
    window.requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }
  async function saveCustom() {
    if (saving.current || busy || disabled || !other || !text.trim()) return;
    let ratio: string;
    try { ratio = normalizeStudioRatio(text); } catch (e) { setValidation((e as Error).message); return; }
    saving.current = true;
    try { if (await onCustom(ratio, false)) select(ratio); }
    finally { saving.current = false; }
  }
  const ratioResolution = resolveStudioAspectRatio(value, reference);
  let size = '', sizeIssue = '';
  try { size = imageOutputSize(model, resolution, ratioResolution.resolved); }
  catch { sizeIssue = '请求尺寸无法确定，请调整分辨率。'; }
  const cardOrder = ['1:1', '1:2', '2:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9', '9:21'];
  const presetRows = [...cardOrder, ...STUDIO_RATIOS.filter(ratio => !cardOrder.includes(ratio))].map(label => ({ label, ratio: normalizeStudioRatio(label), removable: false }));
  const existing = new Set(['auto', ...presetRows.map(item => item.ratio)]);
  const customRows = custom.flatMap(item => {
    let ratio: string;
    try { ratio = normalizeStudioRatio(item); } catch { return []; }
    if (existing.has(ratio)) return [];
    existing.add(ratio);
    return [{ label: ratio, ratio, removable: true }];
  });
  const rows = [{ label: '自动（跟随原图）', ratio: 'auto', removable: false }, ...presetRows, ...customRows];
  if (value !== 'auto' && !rows.some(item => item.ratio === value)) rows.push({ label: `${value}（当前参数）`, ratio: value, removable: false });
  const nativeSize = ratioResolution.resolved === '4:1'
    ? ({ '0.5K': '1024 × 256', '1K': '2048 × 512', '2K': '4096 × 1024', '4K': '8192 × 2048' } as Record<string, string>)[size] : '';
  return <div ref={root} className={styles.ratioPicker} onKeyDown={event => {
    if (menuOpen && menu.current?.contains(event.target as Node) && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && !(event.target instanceof HTMLInputElement)) {
      const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[data-ratio-option]:not(:disabled)') || []);
      if (!buttons.length) return;
      event.preventDefault(); event.stopPropagation();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  }}>
    <div className={styles.ratioHeading}><span className={styles.label} id={`${id}-label`}>图片比例</span><button ref={infoButton} type="button" className={styles.ratioInfoButton} title="比例与请求尺寸" aria-label="比例与请求尺寸" aria-expanded={showInfo} aria-controls={`${id}-info`} onClick={() => { setMenuOpen(false); setShowInfo(current => !current); }}><Info size={16} /></button></div>
    <div className={styles.ratioControl}>
      <button ref={trigger} type="button" className={styles.ratioTrigger} aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls={`${id}-menu`} disabled={disabled || busy}
        onClick={() => { setShowInfo(false); setMenuOpen(current => !current); }}
        onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); setShowInfo(false); setMenuOpen(true); } }}>
        <span id={`${id}-value`}>{value === 'auto' ? '自动（跟随原图）' : value}</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      {menuOpen && <div ref={menu} id={`${id}-menu`} data-ratio-menu className={styles.ratioPopover} role="dialog" aria-labelledby={`${id}-label`} data-above={placement.above}
        style={{ maxHeight: placement.height, width: placement.width, left: placement.left }}>
      <div className={styles.ratioCards} role="group" aria-labelledby={`${id}-label`}>
      {rows.map(({ label, ratio, removable }) => {
        const [width, height] = ratio === 'auto' ? [1, 1] : ratio.split(':').map(Number);
        const scale = 28 / Math.max(width, height);
        return <div className={`${styles.ratioCardWrap} ${ratio === 'auto' ? styles.ratioAuto : ''}`} key={ratio} title={label}>
          <button type="button" data-ratio-option className={styles.ratioCard} aria-label={label} aria-pressed={!other && value === ratio} disabled={disabled || busy} onClick={() => select(ratio)}>
            {ratio !== 'auto' && <span className={styles.ratioShapeSpace} aria-hidden="true"><span className={styles.ratioShape} style={{ width: width * scale, height: height * scale }} /></span>}
            <span>{label}</span>
          </button>
          {removable && <button type="button" className={styles.ratioDelete} title={`删除比例 ${label}`} aria-label={`删除比例 ${label}`} disabled={busy || disabled} onClick={async () => { await onCustom(ratio, true); }}><Trash2 size={13} /></button>}
        </div>;
      })}
      <button type="button" data-ratio-option className={styles.ratioOther} aria-pressed={other} disabled={busy || disabled} onClick={() => { setMenuOpen(false); setOther(true); setText(''); setValidation(''); }}>其他比例</button>
      </div>
      </div>}
    </div>
    {other && <div className={styles.customRatio}>
      <input ref={input} aria-label="自定义图片比例" placeholder="宽:高，例如 5:3" value={text} maxLength={30} disabled={busy || disabled}
        onChange={event => { setText(event.target.value); setValidation(''); }} onBlur={() => void saveCustom()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveCustom(); } }} />
      <button type="button" title="取消自定义比例" aria-label="取消自定义比例" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => { setOther(false); setValidation(''); trigger.current?.focus({ preventScroll: true }); }}><X size={16} /></button>
    </div>}
    {other && <p className={styles.muted}>宽:高，支持 1:3 至 3:1，以及 4:1。输入完成后回车或离开输入框保存。</p>}
    {!other && <p ref={info} id={`${id}-info`} role="tooltip" data-open={showInfo} className={styles.ratioHint}>当前比例 {ratioResolution.resolved}（{ratioResolution.source === 'reference' ? '首张有效参考图' : ratioResolution.source === 'explicit' ? '手动选择' : '模型默认'}）{size && <> · {size.includes('x') ? `请求尺寸 ${size.replace('x', ' × ')}` : `请求档位 ${size}${nativeSize ? ` · ${nativeSize}` : ''}`}</>}。{sizeIssue && <>{sizeIssue}</>}按所选比例请求，实际输出由模型决定。</p>}
    {busy && <p role="status" className={styles.muted}>正在同步比例…</p>}
    {(validation || error) && <p role="alert" className={styles.error}>{validation || error}{error && <button type="button" onClick={other ? () => void saveCustom() : onRetry}>重试</button>}</p>}
  </div>;
}
