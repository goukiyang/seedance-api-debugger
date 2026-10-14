'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { RelativeTime } from '@/components/RelativeTime';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import type { SharedStudioLifecycleHistory, SharedStudioLifecycleHistoryItem } from '@/lib/image-studio/shared-types';
import styles from './studio.module.css';

const actions: Record<string, string> = {
  'studio-published': '首次发布模板', 'studio-definition-saved': '保存模板定义', 'studio-definition-renamed': '修改模板名称',
  'studio-sharing-enabled': '开启共享', 'studio-sharing-disabled': '停止共享', 'studio-source-archived': '删除模板',
  'studio-sharing-preference-changed': '修改下次保存的共享选择',
};
const fields: Record<string, string> = {
  name: '名称', groupName: '分组', templatePrompt: '模板描述', context: '上下文', globalContext: '通用上下文',
  model: '模型', quality: '图片质量', resolution: '分辨率', count: '数量', aspectRatio: '比例', referenceLimit: '参考上限',
  referenceIds: '模板参考', referencePolicy: '参考规则', fixedReferences: '固定参考', styleGroupIds: '风格组',
  skillIds: '提示词组', bannerAssetId: '封面', reproduceFromTaskId: '复现设置',
};
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function history(value: unknown, userId: string): SharedStudioLifecycleHistory {
  if (!plain(value) || !Array.isArray(value.items) || value.items.length > 20
    || value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 160)) {
    throw new Error('模板记录暂无法读取，请重试');
  }
  if (value.items.some(item => !plain(item) || typeof item.id !== 'string' || !item.id || item.id.length > 160
    || typeof item.action !== 'string' || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
    || item.ownerUserId !== userId || !plain(item.detail))) throw new Error('模板记录暂无法确认，请重试');
  return value as unknown as SharedStudioLifecycleHistory;
}
type HistoryState = { scope: string; items: SharedStudioLifecycleHistoryItem[]; nextCursor: string | null; loading: boolean; loaded: boolean; error: string };

export function StudioLifecycleHistory({ userId, presetId, name, onClose, anchor }: {
  userId: string; presetId: string; name: string; onClose: () => void; anchor?: HTMLElement | null;
}) {
  const { sessionChanged } = useAppSession();
  const scopeKey = `${userId}:${presetId}:${sessionChanged}`;
  const scope = useRef({ key: scopeKey });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey };
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const titleId = useId();
  const [state, setState] = useState<HistoryState>({ scope: '', items: [], nextCursor: null, loading: true, loaded: false, error: '' });
  const load = useRef<(cursor: string | null) => void>(() => {});
  const retryCursor = useRef<string | null>(null);
  useDialogDismiss({ open: true, dialogRef: dialog, initialFocusRef: closeButton, nativeDialog: true, onDismiss: () => close.current() });

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const place = () => {
      for (const property of ['position', 'margin', 'left', 'top', 'width', 'max-height']) element.style.removeProperty(property);
      if (!anchor?.isConnected || !anchor.getClientRects().length) return;
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const bounds = anchor.getBoundingClientRect(), below = top + height - bounds.bottom - 16, above = bounds.top - top - 16;
      // A long read-only history needs a usable reading area. Small screens or
      // a detached trigger retain the project's centered native-dialog fallback.
      if (width < 560 || Math.max(below, above) < 280) return;
      const panelWidth = Math.min(640, width - 32), panelHeight = Math.min(520, Math.max(below, above));
      element.style.position = 'fixed'; element.style.margin = '0'; element.style.width = `${panelWidth}px`;
      element.style.maxHeight = `${panelHeight}px`;
      element.style.left = `${Math.max(left + 16, Math.min(bounds.left, left + width - panelWidth - 16))}px`;
      element.style.top = `${below >= above ? bounds.bottom + 8 : Math.max(top + 16, bounds.top - element.getBoundingClientRect().height - 8)}px`;
    };
    if (!element.open) element.showModal();
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element); if (anchor) observer.observe(anchor);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
      element.close();
    };
  }, [anchor]);

  useEffect(() => {
    const current = scope.current, controller = new AbortController();
    let running = false;
    const valid = () => scope.current === current && !controller.signal.aborted && !isClientSessionBlocked() && !sessionChanged;
    const empty: HistoryState = { scope: scopeKey, items: [], nextCursor: null, loading: false, loaded: false, error: '' };
    retryCursor.current = null;
    if (!userId || sessionChanged || isClientSessionBlocked()) {
      setState({ ...empty, error: '请重新登录后查看本人模板记录' });
      load.current = () => {}; return () => controller.abort();
    }
    setState({ ...empty, loading: true });
    const request = async (cursor: string | null) => {
      if (running || !valid()) return;
      running = true; retryCursor.current = cursor;
      setState(previous => ({ ...(previous.scope === scopeKey ? previous : empty), loading: true, error: '' }));
      try {
        const params = new URLSearchParams({ mode: 'history', presetId, limit: '20' });
        if (cursor) params.set('cursor', cursor);
        const response = await fetch(`/api/image-studio/presets?${params}`, {
          credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        const value: unknown = await response.json().catch(() => null);
        if (!valid()) return;
        if (!response.ok) {
          if ([401, 403].includes(response.status)) setState({ ...empty, error: '当前账号无权读取这份模板记录' });
          if (response.status === 409) retryCursor.current = null;
          throw new Error(plain(value) && typeof value.error === 'string' ? value.error : '模板记录暂无法读取，请重试');
        }
        const page = history(value, userId);
        if (page.nextCursor && page.nextCursor === cursor) {
          retryCursor.current = null;
          throw new Error('记录翻页暂无法确认，请重新读取');
        }
        setState(previous => {
          const items = new Map<string, SharedStudioLifecycleHistoryItem>();
          if (cursor && previous.scope === scopeKey) previous.items.forEach(item => items.set(item.id, item));
          page.items.forEach(item => items.set(item.id, item));
          return { scope: scopeKey, items: Array.from(items.values()), nextCursor: page.nextCursor, loading: false, loaded: true, error: '' };
        });
      } catch (cause) {
        if (!valid()) return;
        setState(previous => ({ ...(previous.scope === scopeKey ? previous : empty), loading: false,
          error: cause instanceof Error && !['AbortError', 'TimeoutError'].includes(cause.name) ? cause.message : '模板记录暂无法读取，请重试' }));
      } finally { running = false; }
    };
    load.current = cursor => { void request(cursor); };
    void request(null);
    return () => { controller.abort(); load.current = () => {}; };
  }, [userId, presetId, scopeKey, sessionChanged]);

  const visible = state.scope === scopeKey ? state : null;
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}>
    <header className={styles.header}><h2 id={titleId}>变更记录</h2>
      <button ref={closeButton} type="button" aria-label="关闭变更记录" onClick={() => close.current()}><X size={20} /></button>
    </header>
    <p className={styles.muted}>{name || '本人模板'} · 仅本人可查看</p>
    {(!visible || visible.loading) && <p className={styles.muted} role="status">正在读取模板记录…</p>}
    {visible?.error && <p className={styles.muted} role="status">{visible.error}</p>}
    {visible?.loaded && !visible.loading && !visible.error && !visible.items.length && <p className={styles.muted}>此前变更未记录</p>}
    {Boolean(visible?.items.length) && <ol className={styles.presetList} aria-label="模板变更记录">
      {visible?.items.map(item => <li key={item.id} className={styles.presetItem}>
        <div><strong>{Object.hasOwn(actions, item.action) ? actions[item.action] : '模板变更'}</strong>
          <span>{item.detail.entryPoint === 'template-library' ? '模板库' : item.detail.entryPoint === 'workbench' ? '工作台' : '其他入口'}
            {item.actorUserId === userId ? ' · 本人操作' : ''}</span>
          {typeof item.detail.before?.isShared === 'boolean' && typeof item.detail.after?.isShared === 'boolean'
            && item.detail.before.isShared !== item.detail.after.isShared && <span>
              {item.detail.before.isShared ? '共享' : '仅本人'} → {item.detail.after.isShared ? '共享' : '仅本人'}
            </span>}
          {Array.isArray(item.detail.changedFields) && item.detail.changedFields.some(field => Object.hasOwn(fields, field))
            && <span>修改：{item.detail.changedFields.filter(field => Object.hasOwn(fields, field)).map(field => fields[field]).join('、')}</span>}
        </div><RelativeTime value={item.createdAt} className={styles.muted} />
      </li>)}
    </ol>}
    <footer className={styles.presetActions}>
      {visible?.error && <button type="button" disabled={visible.loading} onClick={() => load.current(retryCursor.current)}>重新读取</button>}
      {!visible?.error && visible?.nextCursor && <button type="button" disabled={visible.loading} onClick={() => load.current(visible.nextCursor)}>加载更多</button>}
      <button type="button" onClick={() => close.current()}>关闭</button>
    </footer>
  </dialog>;
}
