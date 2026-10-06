'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Info, Trash2, X } from 'lucide-react';
import { resolveStudioAspectRatio, normalizeStudioRatio, STUDIO_RATIOS } from '@/lib/image-studio/ratios';
import { imageOutputSize, studioFourToOneIssue } from '@/lib/image-generation/resolution';
import styles from './studio.module.css';

export function RatioPicker({ value, onChange, reference, model, resolution, fourToOneSupported, custom, busy, disabled, error, onRetry, onCustom, onEditing }: {
  value: string; onChange: (ratio: string) => void; reference?: { width?: unknown; height?: unknown } | null; model: string; resolution: string; custom: string[]; busy: boolean; disabled: boolean; error: string;
  onRetry: () => void; onCustom: (ratio: string, remove: boolean) => Promise<boolean>; onEditing: (editing: boolean) => void;
  fourToOneSupported: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const [validation, setValidation] = useState('');
  const saving = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => { onEditing(other); }, [other, onEditing]);
  useEffect(() => { if (other) input.current?.focus(); }, [other]);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); setShowInfo(false); } };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  function select(ratio: string) {
    const issue = studioFourToOneIssue(ratio, fourToOneSupported);
    if (issue) { setValidation(issue); return; }
    onChange(ratio); setOther(false); setValidation(''); setOpen(false); trigger.current?.focus();
  }
  async function saveCustom() {
    if (saving.current || busy || disabled || !other || !text.trim()) return;
    let ratio: string;
    try { ratio = normalizeStudioRatio(text); } catch (e) { setValidation((e as Error).message); return; }
    const issue = studioFourToOneIssue(ratio, fourToOneSupported);
    if (issue) { setValidation(issue); return; }
    saving.current = true;
    try { if (await onCustom(ratio, false)) select(ratio); }
    finally { saving.current = false; }
  }
  const ratioResolution = resolveStudioAspectRatio(value, reference);
  const ratioIssue = studioFourToOneIssue(ratioResolution.resolved, fourToOneSupported);
  const size = ratioIssue ? '' : imageOutputSize(model, resolution, ratioResolution.resolved);
  const preset = STUDIO_RATIOS.find(item => normalizeStudioRatio(item) === value);
  const presetRows = STUDIO_RATIOS.map(label => ({ label, ratio: normalizeStudioRatio(label), removable: false }));
  const existing = new Set(['auto', ...presetRows.map(item => item.ratio)]);
  const customRows = custom.flatMap(item => {
    let ratio: string;
    try { ratio = normalizeStudioRatio(item); } catch { return []; }
    if (existing.has(ratio)) return [];
    existing.add(ratio);
    return [{ label: ratio, ratio, removable: true }];
  });
  const nativeSize = ratioResolution.resolved === '4:1' && !ratioIssue
    ? ({ '0.5K': '1024 × 256', '1K': '2048 × 512', '2K': '4096 × 1024', '4K': '8192 × 2048' } as Record<string, string>)[size] : '';
  return <div ref={root} className={styles.ratioPicker} onKeyDown={event => {
    if (event.key === 'Escape' && (open || showInfo)) { event.stopPropagation(); setOpen(false); setShowInfo(false); trigger.current?.focus(); }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !(event.target instanceof HTMLInputElement)) {
      const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-ratio-menu] button:not(:disabled)') || []);
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  }}>
    <span className={styles.label} id={`${id}-label`}>图片比例</span>
    <button ref={trigger} type="button" className={styles.ratioTrigger} aria-describedby={`${id}-info`} aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={`${id}-menu`} disabled={disabled} onClick={() => setOpen(current => !current)}>
      <span id={`${id}-value`}>{other ? '其他' : value === 'auto' ? '自动（跟随原图）' : preset || value}</span><ChevronDown size={16} />
    </button>
    {open && <div id={`${id}-menu`} data-ratio-menu className={styles.ratioMenu} role="group" aria-label="选择图片比例">
      {[{ label: '自动（跟随原图）', ratio: 'auto', removable: false }, ...presetRows, ...customRows].map(({ label, ratio, removable }) => <div className={styles.ratioRow} key={ratio}>
        <button type="button" aria-pressed={!other && value === ratio} aria-disabled={Boolean(studioFourToOneIssue(ratio, fourToOneSupported))} disabled={disabled || busy} onClick={() => select(ratio)}><span>{label}{ratio === '4:1' && !fourToOneSupported ? '（当前不可用）' : ''}</span>{!other && value === ratio && <Check size={15} />}</button>
        {removable && <button type="button" className={styles.ratioDelete} title={`删除比例 ${label}`} aria-label={`删除比例 ${label}`} disabled={busy || disabled} onClick={async () => {
          if (await onCustom(ratio, true)) trigger.current?.focus();
        }}><Trash2 size={15} /></button>}
      </div>)}
      <button type="button" className={styles.ratioOther} disabled={busy || disabled} onClick={() => { setOther(true); setText(''); setValidation(''); setOpen(false); }}>其他</button>
    </div>}
    {other && <div className={styles.customRatio}>
      <input ref={input} aria-label="自定义图片比例" placeholder="宽:高，例如 5:3" value={text} maxLength={30} disabled={busy || disabled}
        onChange={event => { setText(event.target.value); setValidation(''); }} onBlur={() => void saveCustom()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveCustom(); } }} />
      <button type="button" title="取消自定义比例" aria-label="取消自定义比例" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => { setOther(false); setValidation(''); }}><X size={16} /></button>
    </div>}
    {other && <p className={styles.muted}>宽:高，支持 1:3 至 3:1；4:1须模型与通道支持。输入完成后回车或离开输入框保存。</p>}
    {!other && <><button type="button" className={styles.ratioInfoButton} title="比例与请求尺寸" aria-label="比例与请求尺寸" aria-expanded={showInfo} aria-controls={`${id}-info`} onClick={() => setShowInfo(current => !current)}><Info size={16} /></button><p id={`${id}-info`} role="tooltip" data-open={showInfo} className={styles.ratioHint}>当前比例 {ratioResolution.resolved}（{ratioResolution.source === 'reference' ? '首张有效参考图' : ratioResolution.source === 'explicit' ? '手动选择' : '模型默认'}）{!ratioIssue && <> · {size.includes('x') ? `请求尺寸 ${size.replace('x', ' × ')}` : `请求档位 ${size}${nativeSize ? ` · ${nativeSize}` : ''}`}</>}</p></>}
    {busy && <p role="status" className={styles.muted}>正在同步比例…</p>}
    {(validation || error || ratioIssue) && <p role="alert" className={styles.error}>{validation || error || ratioIssue}{error && <button type="button" onClick={other ? () => void saveCustom() : onRetry}>重试</button>}</p>}
  </div>;
}
