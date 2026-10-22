'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { uploadSession } from '@/lib/http/upload-session';
import { readJsonResponse } from '@/lib/http/json-response';
import { MAX_GENERATION_PROMPT_CHARS } from '@/lib/prompt/limits';
import { isMultiviewGenerationSeed, isMultiviewPresetVersion, MULTIVIEW_REFERENCE_PROMPT_PREFIX,
  type MultiviewRotationPresetState } from '@/lib/video/multiview-generation-contract';
import { isSeedanceVideoDuration, isSeedanceVideoModelId } from '@/lib/provider/seedance-models';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS } from '@/types';
import dialogStyles from '@/components/ProductDialog.module.css';
import styles from './multiview-generation.module.css';

export function parsePresetState(value: unknown): MultiviewRotationPresetState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0 || !row.preset || typeof row.preset !== 'object' || Array.isArray(row.preset)) return null;
  const preset = row.preset as Record<string, unknown>;
  if (preset.id !== 'multiview-360' || !isMultiviewPresetVersion(preset.version) || typeof preset.prompt !== 'string'
    || !preset.prompt.trim() || preset.prompt.length + MULTIVIEW_REFERENCE_PROMPT_PREFIX.length > MAX_GENERATION_PROMPT_CHARS
    || !preset.defaults || typeof preset.defaults !== 'object' || Array.isArray(preset.defaults)
    || !preset.compositionReference || typeof preset.compositionReference !== 'object' || Array.isArray(preset.compositionReference)) return null;
  const defaults = preset.defaults as Record<string, unknown>;
  const reference = preset.compositionReference as Record<string, unknown>;
  if (defaults.provider !== 'seedance' || defaults.generationMode !== 'all_in_one_reference'
    || typeof defaults.model !== 'string' || !isSeedanceVideoModelId(defaults.model) || !RATIO_OPTIONS.includes(defaults.ratio as never)
    || !isSeedanceVideoDuration(defaults.duration, defaults.model) || !RESOLUTION_OPTIONS.includes(defaults.resolution as never)
    || !isMultiviewGenerationSeed(defaults.seed) || typeof defaults.generateAudio !== 'boolean'
    || typeof defaults.returnLastFrame !== 'boolean' || typeof defaults.watermark !== 'boolean'
    || !['assetId', 'referenceImageId', 'ownerId'].every(key => typeof reference[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(reference[key] as string))
    || typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256)) return null;
  return { revision: row.revision as number, preset: { id: 'multiview-360', version: preset.version, prompt: preset.prompt,
    defaults: { provider: 'seedance', generationMode: 'all_in_one_reference', model: defaults.model,
      ratio: defaults.ratio as (typeof RATIO_OPTIONS)[number], duration: defaults.duration,
      resolution: defaults.resolution as (typeof RESOLUTION_OPTIONS)[number], seed: defaults.seed,
      generateAudio: defaults.generateAudio, returnLastFrame: defaults.returnLastFrame, watermark: defaults.watermark },
    compositionReference: { assetId: reference.assetId as string, referenceImageId: reference.referenceImageId as string,
      ownerId: reference.ownerId as string, sha256: reference.sha256 } } };
}

type Props = { open: boolean; ownerId: string; authorityKey: string; onClose: () => void | boolean;
  onSaved: (state: MultiviewRotationPresetState) => void; onStateChange: (value: { unsaved: boolean; busy: boolean }) => void };
const mutationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function MultiviewPromptDialog(props: Props) {
  const [state, setState] = useState<MultiviewRotationPresetState | null>(null);
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [needsRebase, setNeedsRebase] = useState(false);
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const title = useId();
  const live = useRef(props); live.current = props;
  const epoch = useRef(0);
  const busy = useRef(false);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const dirty = Boolean(state && editing && value !== state.preset.prompt);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const valid = Boolean(value.trim() && value.length + MULTIVIEW_REFERENCE_PROMPT_PREFIX.length <= MAX_GENERATION_PROMPT_CHARS);
  const storageKey = `sd2:multiview-preset-save:v1:${props.ownerId}`;
  const capture = () => ({ owner: props.ownerId, authority: props.authorityKey, epoch: epoch.current, uploadEpoch: uploadSession().epoch });
  const current = (scope: ReturnType<typeof capture>) => scope.owner === live.current.ownerId && scope.authority === live.current.authorityKey
    && scope.epoch === epoch.current && !isClientSessionBlocked() && uploadSession().ownerId === scope.owner && uploadSession().epoch === scope.uploadEpoch;
  const dismiss = () => { if (!busy.current) props.onClose(); };
  function cancelOrClose() {
    if (!props.open || busy.current || loading || saving || !current(capture())) return;
    if (props.onClose() === false) return;
    if (!pendingRef.current && state) { setValue(state.preset.prompt); setEditing(false); }
  }
  useDialogDismiss({ open: props.open, dialogRef: dialog, nativeDialog: true, onDismiss: dismiss });
  useEffect(() => {
    epoch.current++; setState(null); setValue(''); setEditing(false); pendingRef.current = null; setPending(null); setNotice(''); setStorageBlocked(false); setNeedsRebase(false); setLoading(false); setSaving(false); busy.current = false;
    try {
      const original = sessionStorage.getItem(storageKey);
      if (original !== null) {
        if (!mutationPattern.test(original)) throw new Error('invalid_mutation');
        pendingRef.current = original; setPending(original);
      }
    } catch { setStorageBlocked(true); setNotice('原保存记录暂无法确认，未新建保存。请保留当前页面。'); }
    return () => { epoch.current++; };
  }, [props.ownerId, props.authorityKey, storageKey]);
  useEffect(() => {
    props.onStateChange({ unsaved: dirty, busy: loading || saving });
  }, [dirty, loading, saving, props.onStateChange]);
  useEffect(() => () => live.current.onStateChange({ unsaved: false, busy: false }), []);

  function adoptSaved(payload: unknown, mutationId: string, scope: ReturnType<typeof capture>) {
    if (!current(scope) || pendingRef.current !== mutationId || !payload || typeof payload !== 'object') return false;
    const receipt = payload as Record<string, unknown>;
    const next = parsePresetState(receipt);
    if (receipt.state !== 'saved' || receipt.mutationId !== mutationId || !next) return false;
    try { if (sessionStorage.getItem(storageKey) === mutationId) sessionStorage.removeItem(storageKey); }
    catch { /* The original saved receipt can safely be queried again after reload. */ }
    pendingRef.current = null; setPending(null); setState(next); setValue(next.preset.prompt); setEditing(false); setNotice('');
    live.current.onSaved(next); live.current.onClose(); return true;
  }
  const readCurrent = useCallback(async () => {
    if (busy.current || isClientSessionBlocked()) return;
    const scope = capture(); busy.current = true; setLoading(true); setNotice('');
    try {
      const response = await fetch('/api/admin/multiview/preset', { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<unknown>(response);
      if (!current(scope)) return;
      if ([401, 403].includes(response.status)) setState(null);
      const next = parsePresetState(payload);
      if (!response.ok || !next) throw new Error('模板提示词暂不可读取，请重试。');
      setState(next); setNeedsRebase(false); if (!dirtyRef.current) setValue(next.preset.prompt);
    } catch { if (current(scope)) setNotice('模板提示词暂不可读取，请重试；编辑内容仍保留。'); }
    finally { if (current(scope)) { busy.current = false; setLoading(false); } }
    // The latest authority is checked again before consuming any response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.ownerId, props.authorityKey]);
  async function queryOriginal() {
    const mutationId = pendingRef.current;
    if (!mutationId || busy.current) return;
    const scope = capture(); busy.current = true; setLoading(true); setNotice('');
    try {
      const response = await fetch(`/api/admin/multiview/preset?mutationId=${encodeURIComponent(mutationId)}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<unknown>(response);
      if (!current(scope)) return;
      if ([401, 403].includes(response.status)) setState(null);
      if (!response.ok || !adoptSaved(payload, mutationId, scope)) setNotice('尚未查到可确认的保存回执，请继续查询原保存；不会自动再次保存。');
    } catch { if (current(scope)) setNotice('保存结果暂未确认，可查询原保存；不会自动再次保存。'); }
    finally { if (current(scope)) { busy.current = false; setLoading(false); } }
  }
  async function save() {
    if (!state || !valid || !dirty || pendingRef.current || storageBlocked || needsRebase || busy.current) return;
    const scope = capture(); if (!current(scope)) return;
    const mutationId = crypto.randomUUID();
    try { sessionStorage.setItem(storageKey, mutationId); if (sessionStorage.getItem(storageKey) !== mutationId) throw new Error('not_retained'); }
    catch { setStorageBlocked(true); setNotice('原保存编号无法保存在此设备，尚未发送；编辑内容仍保留。'); return; }
    pendingRef.current = mutationId; setPending(mutationId); busy.current = true; setSaving(true); setNotice('');
    try {
      const response = await fetch('/api/admin/multiview/preset', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutationId, expectedRevision: state.revision, prompt: value }), signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<unknown>(response);
      if (!current(scope)) return;
      if ([401, 403].includes(response.status)) setState(null);
      const code = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).code : null;
      if (response.status === 400 && code === 'MULTIVIEW_PRESET_INVALID' || response.status === 409 && code === 'MULTIVIEW_PRESET_REVISION_CONFLICT') {
        // These two server codes prove this save did not write. Never replay its PUT.
        try { if (sessionStorage.getItem(storageKey) === mutationId) sessionStorage.removeItem(storageKey); }
        catch { setStorageBlocked(true); }
        pendingRef.current = null; setPending(null); setNeedsRebase(true);
        setNotice(response.status === 409 ? '模板已被更新，本次未保存。编辑内容仍保留，请重新读取当前模板后再主动保存。' : '本次未保存，提示词不符合要求。内容仍保留，请重新读取后调整。');
        return;
      }
      if (!response.ok || !adoptSaved(payload, mutationId, scope)) setNotice(response.status === 409 ? '模板已被更新，当前编辑保留。请查询原保存并重新读取当前模板。' : '保存结果待确认，请查询原保存；编辑内容仍保留。');
    } catch { if (current(scope)) setNotice('保存结果待确认，请查询原保存；不会自动重复保存。'); }
    finally { if (current(scope)) { busy.current = false; setSaving(false); } }
  }
  useEffect(() => {
    if (!props.open) return;
    dialog.current?.showModal();
    void readCurrent();
    return () => { dialog.current?.close(); };
  }, [props.open, readCurrent]);
  useEffect(() => { if (editing && props.open) textarea.current?.focus(); }, [editing, props.open]);
  if (!props.open) return null;
  return createPortal(<dialog ref={dialog} className={`${dialogStyles.dialog} ${styles.promptDialog}`} aria-labelledby={title} aria-modal="true">
    <form onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={loading || saving}>
      <header className={dialogStyles.header}><h2 id={title}>模板提示词</h2><button type="button" className={dialogStyles.close} disabled={loading || saving} onClick={dismiss} aria-label="关闭模板提示词"><X size={18} /></button></header>
      <p className={dialogStyles.message}>保存后用于后续新任务，不改变已提交任务；个人补充要求会保留。</p>
      {state && (editing ? <textarea ref={textarea} className={dialogStyles.input} rows={9} value={value} disabled={saving || Boolean(pending)} aria-label="模板提示词" onChange={event => setValue(event.target.value)} /> : <p className={styles.promptText}>{state.preset.prompt}</p>)}
      {!state && <p className={dialogStyles.message} role="status">{loading ? '正在读取模板提示词…' : '模板提示词尚未读取。'}</p>}
      {editing && !valid && <p className={dialogStyles.message} role="status">提示词不能为空，含素材说明最多 {MAX_GENERATION_PROMPT_CHARS} 字；输入未截断。</p>}
      {pending && !saving && <p className={dialogStyles.message} role="status">上次保存结果待确认，请查询原保存；不会自动再次保存。</p>}
      {notice && <p className={dialogStyles.message} role="status">{notice}</p>}
      <footer className={dialogStyles.actions}>
        {pending && <button type="button" className={dialogStyles.secondary} disabled={loading || saving} onClick={() => void queryOriginal()}>查询原保存</button>}
        {(!state || notice) && <button type="button" className={dialogStyles.secondary} disabled={loading || saving} onClick={() => void readCurrent()}>重新读取</button>}
        <button type="button" className={dialogStyles.secondary} disabled={loading || saving} onClick={cancelOrClose}>{editing && !pending ? '取消' : '关闭'}</button>
        {state && !pending && (editing ? <button type="submit" className={dialogStyles.primary} disabled={!valid || !dirty || loading || saving || storageBlocked || needsRebase}>{saving ? '保存中…' : '保存'}</button> : <button type="button" className={dialogStyles.primary} disabled={loading || storageBlocked} onClick={() => setEditing(true)}>编辑</button>)}
      </footer>
    </form>
  </dialog>, document.body);
}
