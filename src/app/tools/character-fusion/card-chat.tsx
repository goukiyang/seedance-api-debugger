'use client';
import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Plus, Send, X } from 'lucide-react';
import { CARD_CHAT_SYSTEM, parseCardDraft, type CardDraft } from '@/lib/character-fusion/cards';
import { fusionAssistant, type FusionMessage } from '@/lib/character-fusion/assistant';
import styles from './studio.module.css';

export type CardConversation = { messages: FusionMessage[]; input: string; draft: CardDraft | null };
export const emptyConversation = (): CardConversation => ({ messages: [], input: '', draft: null });

export default function CardChat({ value, onChange, onConfirm, onClose, model, modelReady, onChooseModel }: { value: CardConversation; onChange: (v: CardConversation) => void; onConfirm: (draft: CardDraft) => void; onClose: () => void; model: string; modelReady: boolean; onChooseModel: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null), bottom = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [value.messages.length, busy]);
  const send = async () => {
    if (busy || !modelReady || !value.input.trim()) return;
    const messages: FusionMessage[] = [...value.messages, { role: 'user', content: value.input.trim() }];
    const pending = { ...value, messages, input: '', draft: null };
    setBusy(true); setError('');
    const request = new AbortController(); controller.current = request;
    try {
      const data = await fusionAssistant(CARD_CHAT_SYSTEM, messages, request.signal, model) as { reply?: unknown; draft?: unknown };
      if (request.signal.aborted) return;
      if (!data || typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('模型没有返回有效回复，当前卡片未加入。');
      const draft = data.draft ? parseCardDraft(data.draft) : null;
      onChange({ ...pending, messages: [...messages, { role: 'assistant', content: JSON.stringify(data), reply: data.reply }], draft });
    } catch (e) { if (!request.signal.aborted) setError(e instanceof Error ? e.message : '对话暂未完成，输入已保留。'); }
    finally { if (!request.signal.aborted) setBusy(false); }
  };
  return <section className={styles.chat} aria-labelledby="card-chat-title">
    <div className={styles.sectionHead}><div><h3 id="card-chat-title"><MessageCircle size={17} />对话新增卡片</h3><p>描述维度，确认后加入。{modelReady ? `当前模型：${model}` : '先选择对话模型。'}</p></div><button aria-label="收起对话，保留草稿" onClick={onClose}><X size={17} /></button></div>
    <button disabled={busy} onClick={() => onChange({ ...emptyConversation(), draft: value.draft })}>开始新对话</button>
    <div className={styles.chatMessages} role="log" aria-label="卡片设计对话">{!value.messages.length && <p>例如：增加一张“所属阵营”卡片，包含守护者、探索者和流浪者。</p>}{value.messages.map((m, i) => <div key={i} className={m.role === 'user' ? styles.userMessage : styles.assistantMessage}><small>{m.role === 'user' ? '你' : '设计助手'}</small><p>{m.reply || m.content}</p></div>)}{busy && <p role="status">正在梳理卡片与中英标签…</p>}<div ref={bottom} /></div>
    {error && <p role="alert" className={styles.hint}>{error}</p>}
    {!modelReady && <p role="status" className={styles.hint}>当前输入保留。<button type="button" onClick={onChooseModel}>选择 API 模型</button></p>}
    {value.draft && <div className={styles.cardPreview}><h4>{value.draft.title} <small>{value.draft.titleEn} · 待确认</small></h4><label><input type="checkbox" checked={value.draft.multi === true} disabled={busy} onChange={event => onChange({ ...value, draft: { ...value.draft!, multi: event.target.checked } })} />允许多选，所选项共同生效</label><ul>{value.draft.tags.map(t => <li key={t.label}>{t.label}<small>{t.en}</small></li>)}</ul><button className={styles.primary} disabled={busy || Boolean(value.input.trim())} onClick={() => onConfirm(value.draft!)}><Plus size={16} />确认加入卡片</button><small>还想修改可继续聊；确认后加入本次规则，可随配方保存。</small></div>}
    <form className={styles.chatInput} onSubmit={e => { e.preventDefault(); void send(); }}><textarea aria-label="描述或修改卡片" maxLength={2000} rows={2} disabled={busy} value={value.input} placeholder="想增加什么维度？有哪些选项和限制？" onChange={e => onChange({ ...value, input: e.target.value })} /><button disabled={busy || !modelReady || !value.input.trim()}><Send size={16} />{busy ? '思考中…' : '发送'}</button></form>
  </section>;
}
