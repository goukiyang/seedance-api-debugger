'use client';

import { useEffect, useRef, useState } from 'react';
import { Copy, Film, History, RotateCcw, Sparkles } from 'lucide-react';
import type { StudioRunDto } from '@/lib/template-studio/types';
import styles from './template-studio.module.css';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import { studioTextModelLabel } from '@/lib/template-studio/text-models';

export default function VideoPromptResult({ run, userId, busy, onContinue, onRegenerate, onHistory }: {
  run: StudioRunDto; userId: string; busy: boolean;
  onContinue(prompt: string): void; onRegenerate?: () => void; onHistory?: () => void;
}) {
  const key = `sd2-video-result:${userId}:${run.id}`;
  const [text, setText] = useState(run.prompt || '');
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const edited = useRef(false);
  useEffect(() => {
    try {
      const value = localStorage.getItem(key);
      if (value !== null && value !== run.prompt) setSavedDraft(value);
    } catch { /* Text remains usable without browser storage. */ }
  }, [key, run.prompt]);
  useEffect(() => { if (!edited.current) setText(run.prompt || ''); }, [run.prompt]);
  function edit(value: string) {
    edited.current = true; setText(value); setSavedDraft(null);
    try { localStorage.setItem(key, value); setMessage('编辑草稿已保留'); }
    catch { setMessage('本机无法保存草稿，离开前请复制文案'); }
  }
  return <section className={styles.resultPanel} aria-label="文案结果">
    <div className={styles.resultMetadata}><h3>文案结果</h3>{run.owner && <UserIdentityBadge size="sm" user={{ name: run.owner.displayName, avatar_url: run.owner.avatarUrl }} />}{run.llmModel && <span className={styles.fieldHint}>{studioTextModelLabel(run.llmModel)}</span>}<span className={styles.saveState}>{run.status === 'queued' ? '排队中' : run.status === 'running' ? '生成中' : run.status === 'succeeded' ? '已完成' : run.status === 'uncertain' ? '结果待确认' : run.status === 'cancelled' ? '已取消' : '失败'}</span></div>
    {run.status === 'failed' && <p role="alert" className={styles.fieldError}>{run.error || '本次文案生成失败，请检查后重试。'}</p>}
    {run.status === 'uncertain' && <p role="alert" className={styles.fieldError}>结果尚未确认，系统不会重复提交。请先查看历史或联系管理员核对。</p>}
    {run.status === 'succeeded' && !run.prompt && <p role="alert" className={styles.fieldError}>此历史文案无法安全展示，请复用输入重新生成。</p>}
    <div className={styles.field}><label className={styles.visuallyHidden} htmlFor={`video-result-${run.id}`}>编辑文案</label><textarea id={`video-result-${run.id}`} rows={14} value={text} maxLength={12000} disabled={run.status !== 'succeeded' || !run.prompt} onChange={event => edit(event.target.value)} placeholder="文案生成后显示在这里" /></div>
    {savedDraft !== null && <button className={styles.quietButton} type="button" onClick={() => edit(savedDraft)}><RotateCcw size={15} />恢复上一次编辑</button>}
    <div className={styles.promptTools}>
      {run.status === 'succeeded' && run.prompt && text === run.prompt && <ContentReactions contentKey={`prompt:${run.id}`} />}
      {run.status === 'succeeded' && run.prompt && text !== run.prompt && <button className={styles.quietButton} type="button" onClick={() => edit(run.prompt!)}><RotateCcw size={15} />恢复原文</button>}
      <button className={styles.quietButton} type="button" disabled={!text} onClick={() => void navigator.clipboard.writeText(text).then(() => setMessage('已复制文案')).catch(() => setMessage('复制失败，请选择文本手动复制'))}><Copy size={15} />复制文案</button>
      <button className={styles.primaryButton} type="button" disabled={busy || run.status !== 'succeeded' || !text.trim() || !run.prompt} onClick={() => onContinue(text)}><Film size={15} />带到视频生成</button>
      {onRegenerate && <button className={styles.quietButton} type="button" disabled={busy || ['queued', 'running', 'uncertain'].includes(run.status)} onClick={onRegenerate}><Sparkles size={15} />重新生成</button>}
      {onHistory && <button className={styles.iconButton} title="文案历史" aria-label="文案历史" type="button" onClick={onHistory}><History size={16} /></button>}
    </div>
    {message && <p className={styles.fieldHint} role="status">{message}</p>}
  </section>;
}
