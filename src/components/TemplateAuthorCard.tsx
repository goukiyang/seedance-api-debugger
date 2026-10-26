'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
import UserIdentityBadge from './UserIdentityBadge';
import { useDialogDismiss } from './useDialogDismiss';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { readJsonResponse } from '@/lib/http/json-response';
import type { StudioTemplateRead } from '@/lib/image-studio/shared-types';
import styles from './TemplateRead.module.css';

type Contact = { status: 'available' | 'unavailable' | 'unknown'; href?: string; reasonCode?: string };
export function templateInformationLink(read: StudioTemplateRead) {
  const params = new URLSearchParams({ type: 'image', [read.sourceKind === 'local-module' ? 'moduleId' : 'presetId']: read.sourceId, view: 'definition' });
  return `${location.origin}/template-studio?${params}`;
}
export function TemplateAuthorCard({ templateRead: read, name, scopeKey }: { templateRead?: StudioTemplateRead | null; name: string; scopeKey: string }) {
  const { user, sessionChanged } = useAppSession();
  const [open, setOpen] = useState(false), [contact, setContact] = useState<Contact | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0), [copied, setCopied] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), id = useId();
  const sequence = useRef(0);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useDialogDismiss({ open, dialogRef: panel, branchRefs: [trigger], modal: false, onDismiss: close });
  useEffect(() => { sequence.current++; setOpen(false); setContact(null); setError(''); setCopied(false); }, [scopeKey, user?.id, sessionChanged, read?.sourceId, read?.sourceRevision]);
  useEffect(() => {
    if (!open || !read || read.author.state !== 'known' || !user || sessionChanged) return;
    const token = ++sequence.current, controller = new AbortController(); setContact(null); setError('');
    const params = new URLSearchParams({ mode: 'author-contact', [read.sourceKind === 'local-module' ? 'moduleId' : 'presetId']: read.sourceId });
    void fetch(`/api/image-studio/presets?${params}`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const data = await readJsonResponse<Contact & { error?: string }>(response);
      if (token !== sequence.current) return;
      if (!response.ok) throw new Error(data.error || '联系信息暂时无法确认');
      // Only the server's fixed Feishu AppLink route may become an external link.
      const href = data.href ? new URL(data.href) : null;
      if (data.status === 'available' && (!href || href.protocol !== 'https:' || href.hostname !== 'applink.feishu.cn' || href.pathname !== '/client/chat/open')) throw new Error('联系信息暂时无法确认');
      setContact(data);
    }).catch(cause => { if (token === sequence.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '联系信息暂时无法确认'); });
    return () => { sequence.current++; controller.abort(); };
  }, [open, retry, scopeKey, user?.id, sessionChanged, read?.sourceId, read?.sourceRevision]);
  const author = read?.author, known = author?.state === 'known';
  const label = known ? author.isSelf ? '我' : author.displayName || '模板作者' : '作者信息暂不可用';
  return <Popper.Root><Popper.Anchor asChild><button ref={trigger} type="button" className={styles.authorTrigger} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog" title="模板作者"
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setOpen(value => !value); }}>
    <UserIdentityBadge size="sm" user={{ name: label, username: '', avatar_url: author?.avatarUrl || null }} />
  </button></Popper.Anchor>
    {open && createPortal(<Popper.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} avoidCollisions className={styles.authorLayer} onClick={event => event.stopPropagation()}>
      <div ref={panel} id={id} role="dialog" aria-label="模板作者" tabIndex={-1}><strong>{label}</strong>
        {known && !contact && !error && <p role="status">正在读取联系信息</p>}
        {contact?.status === 'available' && contact.href && <a href={contact.href} target="_blank" rel="noopener noreferrer">飞书联系</a>}
        {contact?.status === 'unavailable' && <p>{contact.reasonCode === 'feishu-not-linked' ? '暂未绑定飞书' : '暂时无法通过飞书联系'}</p>}
        {error && <p role="status">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
        {read && <button type="button" onClick={() => void navigator.clipboard.writeText(`${name}\n${templateInformationLink(read)}`).then(() => setCopied(true)).catch(() => setError('未能复制，请重试'))}>{copied ? '已复制模板信息' : '复制模板信息'}</button>}
        <button type="button" onClick={close}>关闭</button>
      </div>
    </Popper.Content>, trigger.current?.closest('dialog[open]') || document.body)}
  </Popper.Root>;
}
