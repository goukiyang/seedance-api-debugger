'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { readJsonResponse } from '@/lib/http/json-response';
import type { StudioTemplateDefinitionRead } from '@/lib/image-studio/shared-types';
import { TemplateAuthorCard } from './TemplateAuthorCard';
import { RelativeTime } from './RelativeTime';
import { useDialogDismiss } from './useDialogDismiss';
import styles from './TemplateRead.module.css';
export function TemplateDefinitionRead({ target, scopeKey, onClose }: { target: { presetId?: string; moduleId?: string }; scopeKey: string; onClose: () => void }) {
  const { user, sessionChanged } = useAppSession();
  const [data, setData] = useState<StudioTemplateDefinitionRead | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null), sequence = useRef(0), owner = useRef(user?.id);
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, onDismiss: onClose });
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    const token = ++sequence.current, controller = new AbortController(); setData(null); setError('');
    if (!user || sessionChanged || owner.current !== user.id) { onClose(); return; }
    const params = new URLSearchParams({ mode: 'definition', ...(target.presetId ? { presetId: target.presetId } : { moduleId: target.moduleId || '' }) });
    void fetch(`/api/image-studio/presets?${params}`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const result = await readJsonResponse<StudioTemplateDefinitionRead & { error?: string }>(response);
      if (token !== sequence.current) return;
      if (!response.ok) throw new Error(result.error || '模板上下文暂不可读'); setData(result);
    }).catch(cause => { if (token === sequence.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '模板上下文暂不可读'); });
    return () => { sequence.current++; controller.abort(); };
  }, [scopeKey, target.presetId, target.moduleId, user?.id, sessionChanged, retry]);
  return createPortal(<dialog ref={dialog} className={styles.definitionDialog} aria-labelledby="template-definition-heading"><header><h2 id="template-definition-heading">模板上下文</h2><button type="button" aria-label="关闭上下文" onClick={onClose}>关闭</button></header>
    {error ? <p role="status">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button></p> : !data ? <p role="status">正在读取模板上下文</p> : <>
      <h3>{data.definition.name}</h3><TemplateAuthorCard templateRead={data.templateRead} name={data.definition.name} scopeKey={scopeKey} />
      <p>{data.lifecycle === 'archived' ? '已归档' : '现存模板'} · {data.generation.available === true ? '当前可生成' : data.generation.available === false ? '当前不可生成' : '生成条件待确认'}</p>
      <dl><dt>模板提示词</dt><dd>{data.definition.templatePrompt || '未设置'}</dd><dt>模板上下文</dt><dd>{data.definition.context || '未设置'}</dd></dl>
      {data.definition.referenceNotes.length > 0 && <details><summary>固定参考说明</summary>{data.definition.referenceNotes.map((note, index) => <p key={index}>{note}</p>)}</details>}
      <p>张数 {data.definition.limits.count} · 参考上限 {data.definition.limits.referenceLimit} · 比例 {data.definition.limits.aspectRatio}</p>
      <small>本次读取 <RelativeTime value={data.readAt} /></small>
    </>}
  </dialog>, document.body);
}
