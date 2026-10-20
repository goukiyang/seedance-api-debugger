'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CopyPlus, Pencil, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useProductDialog } from '@/components/useProductDialog';
import { ProductActionMenu } from '@/components/ProductActionMenu';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { readJsonResponse } from '@/lib/http/json-response';
import { uploadSession } from '@/lib/http/upload-session';
import { defaultMultiviewGenerationDraft, isMultiviewPresetVersion } from '@/lib/video/multiview-generation-contract';
import { isMultiviewSettingsId, parseMultiviewSettingsDto, parseMultiviewGenerationSettingsValue, parseMultiviewFrameSettingsInput,
  type MultiviewGenerationSettingsValue, type MultiviewFrameSettingsInput, type MultiviewSettingsBinding,
  type MultiviewSettingsKind, type MultiviewSettingsSummary, type MultiviewSettingsDto,
  type MultiviewSettingsApplyResult, type MultiviewSettingsSource } from '@/lib/video/multiview-settings-contract';
import styles from './multiview-generation.module.css';

export type { MultiviewGenerationSettingsValue } from '@/lib/video/multiview-settings-contract';
export type MultiviewFrameSettingsValue = MultiviewFrameSettingsInput;
export type MultiviewSettingsPickerValue = MultiviewGenerationSettingsValue | MultiviewFrameSettingsInput;
type Summary = MultiviewSettingsSummary;
export type MultiviewSettingsPickerRecord = MultiviewSettingsDto;
export type MultiviewSettingsPickerApplyResult = MultiviewSettingsApplyResult;
type Props = { kind: MultiviewSettingsKind; ownerId: string; authorityKey: string; disabled: boolean;
  value: MultiviewSettingsPickerValue | null; binding?: MultiviewSettingsBinding; source?: MultiviewSettingsSource; target?: MultiviewSettingsSource;
  onApply: (result: MultiviewSettingsPickerApplyResult) => void | Promise<void>; onReset?: () => void | Promise<void>;
  onSaved?: (record: MultiviewSettingsPickerRecord) => void | Promise<void>;
  onRenamed?: (record: MultiviewSettingsPickerRecord, previousRevision: number) => void;
  onStateChange?: (state: { busy: boolean; unsaved: boolean }) => void };
type Mutation = { mutationId: string; kind: MultiviewSettingsKind };
const base = '/api/multiview/settings';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const mutationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function summary(value: unknown, kind: MultiviewSettingsKind): Summary | null {
  if (!object(value) || !isMultiviewSettingsId(value.id) || value.kind !== kind || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80
    || typeof value.isShared !== 'boolean' || typeof value.ownedByViewer !== 'boolean' || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return null;
  return { id: value.id, kind, name: value.name, isShared: value.isShared, ownedByViewer: value.ownedByViewer,
    revision: value.revision as number, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
export function generationSettingsValue(draft: ReturnType<typeof defaultMultiviewGenerationDraft>): MultiviewGenerationSettingsValue {
  return { schema: 1, presetId: 'multiview-360', presetVersion: draft.presetVersion, provider: draft.provider, generationMode: draft.generationMode,
    model: draft.model, ratio: draft.ratio, duration: draft.duration, resolution: draft.resolution, supplement: draft.supplement,
    seed: draft.seed, generateAudio: draft.generateAudio, returnLastFrame: draft.returnLastFrame, watermark: draft.watermark };
}
function record(value: unknown, kind: MultiviewSettingsKind): MultiviewSettingsPickerRecord | null {
  const parsed = parseMultiviewSettingsDto(value);
  return parsed?.kind === kind ? parsed : null;
}

export function MultiviewSettingsPicker(props: Props) {
  return <MultiviewSettingsPickerContent key={`${props.ownerId}:${props.authorityKey}:${props.kind}`} {...props} />;
}

function MultiviewSettingsPickerContent(props: Props) {
  const { prompt, confirm, productDialog } = useProductDialog();
  const label = props.kind === 'generation' ? '生成设置' : '选帧方案';
  const inputId = useId();
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<MultiviewSettingsPickerRecord | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Mutation | null>(null);
  const [notice, setNotice] = useState('');
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [dialogDirty, setDialogDirty] = useState(false);
  const lock = useRef(false);
  const epoch = useRef(0);
  const live = useRef(props); live.current = props;
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const valueRef = useRef(props.value); valueRef.current = props.value;
  const storageKey = `sd2:multiview-settings-mutation:v1:${props.ownerId}:${props.kind}`;
  const capture = () => ({ owner: props.ownerId, authority: props.authorityKey, epoch: epoch.current, uploadEpoch: uploadSession().epoch });
  const current = (scope: ReturnType<typeof capture>) => scope.owner === live.current.ownerId && scope.authority === live.current.authorityKey
    && scope.epoch === epoch.current && !isClientSessionBlocked() && uploadSession().ownerId === scope.owner && uploadSession().epoch === scope.uploadEpoch;
  const headers = (owner: string) => ({ 'Content-Type': 'application/json', 'x-app-session-user': owner });
  const displaySelection = items.find(item => item.id === selected) || (selectedRecord?.id === selected ? selectedRecord : null);
  const owned = Boolean(displaySelection?.ownedByViewer);
  const bindingKey = props.binding ? `${props.binding.id}:${props.binding.revision}` : '';
  function readOriginal(): Mutation | null {
    // Each operation has its own durable row so another tab cannot overwrite an unknown save.
    const keys = [storageKey];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(`${storageKey}:`)) keys.push(key);
    }
    for (const key of keys) {
      const raw = localStorage.getItem(key); if (!raw) continue;
      const saved: unknown = JSON.parse(raw);
      if (!object(saved) || saved.kind !== props.kind || typeof saved.mutationId !== 'string' || !mutationPattern.test(saved.mutationId)) throw new Error('invalid');
      return { kind: props.kind, mutationId: saved.mutationId };
    }
    return null;
  }

  const load = useCallback(async (cursor?: string) => {
    const scope = capture(); if (!current(scope)) return;
    setLoading(true);
    try {
      const response = await fetch(`${base}?kind=${props.kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
        headers: headers(scope.owner), cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<unknown>(response);
      if (!current(scope)) return;
      if (!response.ok || !object(payload) || !Array.isArray(payload.items)
        || payload.nextCursor !== null && typeof payload.nextCursor !== 'string') throw new Error('设置列表暂不可读取，请重试；当前输入保留。');
      const rows = payload.items.map(item => summary(item, props.kind));
      if (rows.some(item => !item)) throw new Error('设置列表暂不可确认，请重新读取。');
      setItems(previous => Array.from(new Map([...(cursor ? previous : []), ...rows as Summary[]].map(item => [item.id, item])).values()));
      setNextCursor(payload.nextCursor as string | null);
    } catch (cause) { if (current(scope)) setNotice(cause instanceof Error ? cause.message : '设置列表读取失败，请重试。'); }
    finally { if (current(scope)) setLoading(false); }
    // Authority and account changes invalidate all old responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.ownerId, props.authorityKey, props.kind]);
  useEffect(() => {
    epoch.current++; lock.current = false; setBusy(false); setItems([]); setNextCursor(null); setSelected(''); setSelectedRecord(null); setNotice('');
    pendingRef.current = null; setPending(null); setStorageBlocked(false); setDialogDirty(false);
    try {
      const original = readOriginal();
      if (original) {
        pendingRef.current = original; setPending(original);
      }
    } catch { setStorageBlocked(true); setNotice('原保存记录暂无法读取，尚未新建保存；当前设置保留。'); }
    void load();
    return () => { epoch.current++; };
  }, [load, props.kind, storageKey]);
  useEffect(() => {
    setSelected(props.binding?.id || ''); setSelectedRecord(null);
    const binding = props.binding; if (!binding) return;
    const scope = capture(); const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${base}/${encodeURIComponent(binding.id)}`, { headers: headers(scope.owner), cache: 'no-store', signal: controller.signal });
        const payload = await readJsonResponse<unknown>(response);
        if (!current(scope) || controller.signal.aborted) return;
        const item = response.ok && object(payload) ? record(payload.settings, props.kind) : null;
        if (item) setSelectedRecord(item);
      } catch { /* A restored label is not permission to apply or overwrite a saved setting. */ }
    })();
    return () => controller.abort();
    // Selection restoration reads metadata only; application remains an explicit user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingKey, props.ownerId, props.authorityKey, props.kind]);
  useEffect(() => { live.current.onStateChange?.({ busy, unsaved: dialogDirty }); }, [busy, dialogDirty]);
  useEffect(() => () => live.current.onStateChange?.({ busy: false, unsaved: false }), []);

  function clearPending(mutationId: string) {
    if (pendingRef.current?.mutationId !== mutationId) return;
    try {
      localStorage.removeItem(`${storageKey}:${mutationId}`);
      const pointer = localStorage.getItem(storageKey);
      const previous: unknown = pointer ? JSON.parse(pointer) : null;
      if (object(previous) && previous.kind === props.kind && previous.mutationId === mutationId) localStorage.removeItem(storageKey);
    }
    catch { setStorageBlocked(true); }
    let next: Mutation | null = null;
    try { next = readOriginal(); } catch { setStorageBlocked(true); }
    pendingRef.current = next; setPending(next);
  }
  function adoptReceipt(payload: unknown, mutationId: string) {
    if (!object(payload) || payload.state !== 'committed' || payload.mutationId !== mutationId || !['create', 'save', 'rename', 'delete'].includes(String(payload.action))) return false;
    const saved = record(payload.settings, props.kind); if (!saved) return false;
    clearPending(mutationId);
    if (payload.action === 'delete') {
      setItems(previous => previous.filter(item => item.id !== saved.id));
      setSelectedRecord(previous => previous?.id === saved.id ? null : previous);
      setNotice('设置已删除，当前输入和已有任务保留；请选用有效设置或默认模板后继续。');
      return saved;
    }
    setItems(previous => [saved, ...previous.filter(item => item.id !== saved.id)]);
    setNotice(payload.action === 'rename' ? '设置已重命名。' : `${label}已保存${saved.isShared ? '，同事可选用' : '，仅自己可见'}。`);
    return saved;
  }
  async function queryOriginal() {
    const original = pendingRef.current; if (!original || lock.current) return;
    const scope = capture(); if (!current(scope)) return;
    lock.current = true; setBusy(true); setNotice('');
    try {
      const response = await fetch(`${base}/mutations/${encodeURIComponent(original.mutationId)}`, { headers: headers(scope.owner), cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<unknown>(response);
      if (!current(scope)) return;
      const restored = response.ok ? adoptReceipt(payload, original.mutationId) : null;
      if (!restored) setNotice('操作结果仍待确认，请继续查询原操作；不会重复提交。');
      else if (object(payload) && payload.action === 'rename') live.current.onRenamed?.(restored, restored.revision - 1);
    } catch { if (current(scope)) setNotice('操作结果暂未确认，请继续查询原操作；当前设置保留。'); }
    finally { if (current(scope)) { lock.current = false; setBusy(false); } }
  }
  async function manage(action: 'rename' | 'delete', anchor: HTMLElement) {
    if (!displaySelection?.ownedByViewer || lock.current || pendingRef.current || storageBlocked || live.current.disabled) return;
    const item = displaySelection; const scope = capture(); if (!current(scope)) return;
    const submit = async (name?: string) => {
      if (!current(scope) || lock.current || pendingRef.current || live.current.disabled) throw new Error('操作状态已变化，请重新打开设置管理。');
      let other: Mutation | null;
      try { other = readOriginal(); } catch { setStorageBlocked(true); throw new Error('原操作记录暂不可读取，尚未提交。'); }
      if (other) { pendingRef.current = other; setPending(other); throw new Error('已有操作待确认，请先查询原操作。'); }
      const mutationId = crypto.randomUUID(); const original = { mutationId, kind: props.kind };
      try {
        const bytes = JSON.stringify(original); localStorage.setItem(`${storageKey}:${mutationId}`, bytes);
        if (localStorage.getItem(`${storageKey}:${mutationId}`) !== bytes) throw new Error('not_retained');
      } catch { setStorageBlocked(true); throw new Error('原操作编号未能保留，尚未提交。'); }
      pendingRef.current = original; setPending(original); lock.current = true; setBusy(true);
      try {
        const response = await fetch(`${base}/${encodeURIComponent(item.id)}`, { method: action === 'delete' ? 'DELETE' : 'PATCH',
          headers: headers(scope.owner), body: JSON.stringify({ mutationId, expectedRevision: item.revision, ...(action === 'rename' ? { action, name } : {}) }),
          signal: AbortSignal.timeout(30000) });
        const payload = await readJsonResponse<unknown>(response);
        if (!current(scope)) return;
        const changed = response.ok && object(payload) && payload.action === action ? adoptReceipt(payload, mutationId) : null;
        if (!changed) {
          if (object(payload) && payload.notCommitted === true) { clearPending(mutationId); void load(); throw new Error('本次未修改，设置可能已变化。请重新读取后再操作。'); }
          throw new Error('操作结果待确认，请查询原操作，不会重复提交。');
        }
        if (action === 'rename') {
          setSelectedRecord(changed);
          live.current.onRenamed?.(changed, item.revision);
        }
      } finally { if (current(scope)) { lock.current = false; setBusy(false); } }
    };
    if (action === 'rename') {
      await prompt('设置名称', item.name, { title: '重命名设置', anchor, maxLength: 80, onSubmit: name => submit(name) });
    } else {
      await confirm(`删除“${item.name}”？${item.isShared ? '同事将无法再选用。' : ''}现有图片、视频和任务保留。`, {
        title: '删除设置', confirmLabel: '删除', danger: true, anchor, onSubmit: () => submit(),
      });
    }
  }
  async function save(copy: boolean, anchor: HTMLElement) {
    if (lock.current || pendingRef.current || storageBlocked || live.current.disabled || !valueRef.current) return;
    const raw = valueRef.current;
    const initial = props.kind === 'generation' ? parseMultiviewGenerationSettingsValue(raw)
      : parseMultiviewFrameSettingsInput({ schema: 1, slots: (raw as MultiviewFrameSettingsInput).slots });
    if (!initial) { setNotice('当前设置不完整，请调整后再保存；输入保留。'); return; }
    const valueKey = JSON.stringify(valueRef.current); const scope = capture(); if (!current(scope)) return;
    const initialSource = props.source; const sourceKey = JSON.stringify(initialSource || null);
    const sourceBinding = props.binding; const sourceBindingKey = JSON.stringify(sourceBinding || null);
    const edit = !copy && displaySelection?.ownedByViewer ? displaySelection : null;
    const name = edit?.name || displaySelection?.name || (props.kind === 'generation' ? '360°旋转设置' : '多视图选帧方案');
    const submit = async (nextName: string, isShared: boolean) => {
        if (lock.current || pendingRef.current || !current(scope) || live.current.disabled) throw new Error('当前操作状态已变化，请关闭后重新保存。');
        if (JSON.stringify(valueRef.current) !== valueKey) throw new Error('当前设置已变化，请关闭后按当前设置重新保存。');
        if (sourceKey !== JSON.stringify(live.current.source || null)) throw new Error('当前视频已变化，请关闭后重新保存。');
        if (sourceBindingKey !== JSON.stringify(live.current.binding || null)) throw new Error('当前设置来源已变化，请关闭后重新保存。');
        const mutationId = crypto.randomUUID(); const original = { mutationId, kind: props.kind };
        let other: Mutation | null;
        try { other = readOriginal(); }
        catch { setStorageBlocked(true); throw new Error('原保存记录暂不可读取，尚未新建保存；当前设置保留。'); }
        if (other) { pendingRef.current = other; setPending(other); throw new Error('已有保存待确认，请先关闭此层并查询原保存。'); }
        try {
          const bytes = JSON.stringify(original); localStorage.setItem(`${storageKey}:${mutationId}`, bytes);
          if (localStorage.getItem(`${storageKey}:${mutationId}`) !== bytes) throw new Error('not_retained');
        }
        catch { setStorageBlocked(true); throw new Error('原保存编号未能保存在此设备，尚未发送；当前设置保留。'); }
        pendingRef.current = original; setPending(original); lock.current = true; setBusy(true); setNotice('');
        try {
          const response = await fetch(edit ? `${base}/${encodeURIComponent(edit.id)}` : base, { method: edit ? 'PATCH' : 'POST', headers: headers(scope.owner),
            body: JSON.stringify({ mutationId, ...(edit ? { expectedRevision: edit.revision } : { kind: props.kind }), name: nextName, isShared, value: initial,
              ...(props.kind === 'generation' && sourceBinding ? { sourceSettingsBinding: sourceBinding } : {}),
              ...(props.kind === 'frame' ? { source: initialSource } : {}) }), signal: AbortSignal.timeout(30000) });
          const payload = await readJsonResponse<unknown>(response);
          if (!current(scope)) throw new Error('账号或权限已变化，请在原账号查询保存结果。');
          const savedRecord = response.ok ? adoptReceipt(payload, mutationId) : null;
          if (!savedRecord) {
            if (object(payload) && payload.notCommitted === true) { clearPending(mutationId); void load(); throw new Error('本次未保存，设置可能已更新或不再可用。请重新读取后再保存，当前输入保留。'); }
            throw new Error('保存结果待确认，请关闭此层后查询原保存；不会重复另存。');
          }
          if (JSON.stringify(valueRef.current) === valueKey && sourceKey === JSON.stringify(live.current.source || null)
            && sourceBindingKey === JSON.stringify(live.current.binding || null)) {
            await live.current.onSaved?.(savedRecord);
            if (current(scope)) { setSelected(savedRecord.id); setSelectedRecord(savedRecord); }
          }
        } catch (cause) {
          if (current(scope) && pendingRef.current) setNotice('保存结果待确认，请查询原保存；当前设置保留。');
          throw cause instanceof Error ? cause : new Error('保存结果待确认，请查询原保存。');
        } finally { if (current(scope)) { lock.current = false; setBusy(false); } }
      };
    if (edit) {
      try { await submit(edit.name, edit.isShared); }
      catch (cause) { if (current(scope)) setNotice(cause instanceof Error ? cause.message : '本次保存尚未确认，请查询原保存。'); }
      return;
    }
    await prompt(`保存${label}，不包含图片、视频、作品或项目归属。`, name, { title: copy ? '另存为设置' : '保存设置', confirmLabel: '保存设置', maxLength: 80, anchor,
      checkbox: { label: '共享给同事', checked: true }, onDraftChange: setDialogDirty, onSubmit: submit });
  }
  async function apply(id: string, editing = false) {
    if (lock.current || props.disabled) return;
    const scope = capture(); if (!current(scope)) return;
    const targetKey = JSON.stringify(props.target || null); const valueKey = JSON.stringify(valueRef.current);
    lock.current = true; setBusy(true); setNotice('');
    try {
      if (!id) {
        if (live.current.onReset) await live.current.onReset();
        if (current(scope)) { setSelected(''); setSelectedRecord(null); }
        return;
      }
      const response = await fetch(`${base}/${encodeURIComponent(id)}`, { headers: headers(scope.owner), cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const detail = await readJsonResponse<unknown>(response); if (!current(scope)) return;
      const fresh = object(detail) ? record(detail.settings, props.kind) : null;
      if (!response.ok || !fresh) throw new Error('这份设置暂不可用，当前输入保留；请刷新列表。');
      if (editing && !fresh.ownedByViewer) throw new Error('共享设置只能由创建者编辑，可另存为自己的设置。');
      const checked = await fetch(`${base}/${encodeURIComponent(id)}/apply`, { method: 'POST', headers: headers(scope.owner),
        body: JSON.stringify({ expectedRevision: fresh.revision, ...(props.kind === 'frame' ? { target: props.target } : {}) }), signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<unknown>(checked); if (!current(scope)) return;
      const applied = object(payload) ? record(payload.settings, props.kind) : null;
      if (!checked.ok || !applied || applied.id !== id || applied.revision !== fresh.revision) throw new Error('设置已变化或暂不可用，当前输入保留；请刷新后重新选用。');
      if (live.current.disabled || targetKey !== JSON.stringify(live.current.target || null) || valueKey !== JSON.stringify(valueRef.current)) throw new Error('当前工作现场已变化，请重新选用设置。');
      const result: MultiviewSettingsPickerApplyResult = { settings: applied };
      if (props.kind === 'generation') {
        const preset = object(payload) && object(payload.preset) ? payload.preset : null;
        if (!preset || preset.id !== 'multiview-360' || !isMultiviewPresetVersion(preset.version) || typeof preset.prompt !== 'string' || !preset.prompt.trim()
          || preset.version !== (applied.value as MultiviewGenerationSettingsValue).presetVersion) throw new Error('这份设置的模板提示词暂不可确认，当前输入保留。');
        result.preset = { id: 'multiview-360', version: preset.version, prompt: preset.prompt };
      } else {
        const slots = object(payload) ? parseMultiviewFrameSettingsInput({ schema: 1, slots: payload.slots }) : null;
        if (!slots) throw new Error('当前视频暂不能使用这份选帧方案，原选帧保留。');
        result.slots = slots.slots;
      }
      await live.current.onApply(result);
      if (!current(scope)) return;
      setSelected(id); setSelectedRecord(applied); setItems(previous => previous.map(item => item.id === id ? applied : item));
      setNotice(editing ? '已载入原设置，调整后点击保存设置覆盖。' : '');
    } catch (cause) { if (current(scope)) setNotice(cause instanceof Error ? cause.message : '设置未应用，原输入保留。'); }
    finally { if (current(scope)) { lock.current = false; setBusy(false); } }
  }
  return <div className={styles.settingsPicker} aria-busy={busy}>
    <div className={styles.settingsPickerRow}>
      <label className={styles.settingsPickerSelect} htmlFor={inputId}>{label}<select id={inputId} value={selected} disabled={props.disabled || busy || loading} onChange={event => void apply(event.target.value)}>
        <option value="">{props.kind === 'generation' ? '当前360°旋转模板' : '当前选帧'}</option>
        {selected && !items.some(item => item.id === selected) && <option value={selected}>{selectedRecord?.name || '原设置待核对（输入保留）'}</option>}
        {items.map(item => <option value={item.id} key={item.id}>{item.name} · {item.ownedByViewer ? '我的' : '同事共享'}{item.ownedByViewer ? item.isShared ? ' · 已共享' : ' · 私有' : ''}</option>)}
      </select></label>
      <div className={styles.settingsPickerActions}>
        <button type="button" disabled={props.disabled || busy || Boolean(pending) || storageBlocked || !props.value || Boolean(selected && !owned)} title={selected && !owned ? '共享设置由创建者维护，可另存为自己的设置' : undefined} onClick={event => void save(false, event.currentTarget)}><Save size={14} />保存设置</button>
        <ProductActionMenu label={`管理${label}`} disabled={busy} actions={[
          { id: 'edit', label: '编辑所选设置', icon: <Pencil size={14} />, disabled: props.disabled || !owned || Boolean(pending), onSelect: () => void apply(selected, true) },
          { id: 'overwrite', label: '用当前设置覆盖', icon: <Save size={14} />, disabled: props.disabled || !owned || Boolean(pending) || storageBlocked || !props.value, onSelect: anchor => void save(false, anchor) },
          { id: 'copy', label: '另存为设置', icon: <CopyPlus size={14} />, disabled: props.disabled || Boolean(pending) || storageBlocked || !props.value, onSelect: anchor => void save(true, anchor) },
          { id: 'rename', label: '重命名', icon: <Pencil size={14} />, disabled: props.disabled || !owned || Boolean(pending) || storageBlocked, onSelect: anchor => void manage('rename', anchor) },
          { id: 'delete', label: '删除设置', icon: <Trash2 size={14} />, danger: true, disabled: props.disabled || !owned || Boolean(pending) || storageBlocked, onSelect: anchor => void manage('delete', anchor) },
          { id: 'reset', label: props.kind === 'generation' ? '使用当前默认模板' : '解除方案绑定', disabled: props.disabled || !props.onReset || Boolean(pending), onSelect: () => void apply('') },
          { id: 'refresh', label: '刷新设置列表', icon: <RefreshCw size={14} />, disabled: loading, onSelect: () => void load() },
        ]} />
      </div>
    </div>
    {(pending || notice || loading || nextCursor) && <div className={styles.settingsPickerNotice} role="status">
      <span>{busy ? '正在处理设置…' : loading ? '正在读取设置…' : pending ? notice || '上次操作结果待确认，请查询原操作。' : notice}</span>
      {pending && <button type="button" className={styles.quiet} disabled={busy} onClick={() => void queryOriginal()}>查询原操作</button>}
      {nextCursor && <button type="button" className={styles.quiet} disabled={busy || loading} onClick={() => void load(nextCursor)}>加载更多设置</button>}
    </div>}
    {productDialog}
  </div>;
}
