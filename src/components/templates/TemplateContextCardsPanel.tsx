'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ImageIcon, Plus, GripVertical, Trash2 } from 'lucide-react';
import { normalizeContextCardTitle } from '@/lib/templates/workbench';
import type {
  TemplateContextCard,
  TemplateContextCardBoundImage,
  TemplateContextCardMode,
} from '@/lib/templates/workbench';
import { TemplateBoundImagePicker } from '@/components/templates/TemplateBoundImagePicker';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

type Props = {
  cards: TemplateContextCard[];
  saveStatus: SaveStatus;
  saveError?: string | null;
  editorActions?: ReactNode;
  templateId?: string;
  editorMode?: 'overview' | 'inline' | 'card-page';
  editingCardId?: string | null;
  backHref?: string;
  onChange: (cards: TemplateContextCard[]) => void;
  onRewriteCard: (card: TemplateContextCard, instruction: string) => Promise<string>;
};

function makeCardId() {
  return `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createEmptyCard(sortOrder: number): TemplateContextCard {
  return {
    id: makeCardId(),
    title: '新上下文卡片',
    content: '',
    mode: 'reference',
    enabled: true,
    sort_order: sortOrder,
    bound_image: null,
    llm_reference: '',
  };
}

function reorderCards(cards: TemplateContextCard[]) {
  return cards.map((card, index) => ({ ...card, sort_order: index + 1 }));
}

function normalizeCardTitle(card: TemplateContextCard, fallbackIndex: number) {
  return normalizeContextCardTitle(card.title, card.legacy_block_type, fallbackIndex);
}

function modeLabel(mode: TemplateContextCardMode) {
  return mode === 'force' ? '强制插入' : '仅供参考';
}

function saveStatusText(status: SaveStatus, error?: string | null) {
  if (status === 'saving') return '正在自动保存';
  if (status === 'saved') return '已自动保存';
  if (status === 'error') return error || '自动保存失败';
  return '等待修改';
}

export function TemplateContextCardsPanel({
  cards,
  saveStatus,
  saveError,
  editorActions,
  templateId,
  editorMode = 'overview',
  editingCardId = null,
  backHref,
  onChange,
  onRewriteCard,
}: Props) {
  const [internalEditingCardId, setInternalEditingCardId] = useState<string | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [referenceExpanded, setReferenceExpanded] = useState(false);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState('');
  const autoSelectedCardIdRef = useRef<string | null>(null);

  const sortedCards = useMemo(
    () => [...cards]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((card, index) => ({
        ...card,
        title: normalizeCardTitle(card, index + 1),
      })),
    [cards],
  );
  const effectiveEditingCardId = editorMode === 'card-page' ? editingCardId : internalEditingCardId;
  const editingCard = sortedCards.find((card) => card.id === effectiveEditingCardId) || null;
  const showInlineEditor = editorMode === 'inline';
  const showCardEditorPage = editorMode === 'card-page';
  const enabledCards = sortedCards.filter((card) => card.enabled);
  const forceCards = enabledCards.filter((card) => card.mode === 'force');
  const referenceCards = enabledCards.filter((card) => card.mode === 'reference');
  const boundImageCards = enabledCards.filter((card) => card.bound_image);
  const forceCount = enabledCards.filter((card) => card.mode === 'force').length;
  const referenceCount = enabledCards.filter((card) => card.mode === 'reference').length;
  const imageCount = enabledCards.filter((card) => card.bound_image).length;
  const finalPromptText = useMemo(
    () => enabledCards.map((card, index) => {
      const prefix = card.mode === 'force' ? '必须写入' : '参考理解';
      return `${index + 1}. ${prefix}：${card.title}\n${card.content || '草稿未写内容'}`;
    }).join('\n\n'),
    [enabledCards],
  );

  useEffect(() => {
    if (!showInlineEditor) return;
    if (internalEditingCardId && sortedCards.some((card) => card.id === internalEditingCardId)) return;
    const firstCard = sortedCards[0];
    if (!firstCard || autoSelectedCardIdRef.current === firstCard.id) return;
    autoSelectedCardIdRef.current = firstCard.id;
    setInternalEditingCardId(firstCard.id);
  }, [internalEditingCardId, showInlineEditor, sortedCards]);

  const updateCard = (cardId: string, patch: Partial<TemplateContextCard>) => {
    onChange(sortedCards.map((card, index) => {
      if (card.id !== cardId) return card;
      const next = { ...card, ...patch };
      return {
        ...next,
        title: normalizeCardTitle(next, index + 1),
      };
    }));
  };

  const addCard = () => {
    const next = [...sortedCards, createEmptyCard(sortedCards.length + 1)];
    onChange(next);
    setInternalEditingCardId(next[next.length - 1].id);
    setReferenceExpanded(false);
  };

  const removeBoundImage = (cardId: string) => {
    updateCard(cardId, { bound_image: null });
  };

  const deleteCard = (cardId: string) => {
    const card = sortedCards.find((item) => item.id === cardId);
    if (!card) return;
    const confirmed = window.confirm(`删除「${card.title}」这张上下文卡片？删除后会自动保存。`);
    if (!confirmed) return;

    const nextCards = reorderCards(sortedCards.filter((item) => item.id !== cardId));
    onChange(nextCards);
    if (effectiveEditingCardId === cardId) {
      setInternalEditingCardId(nextCards[0]?.id || null);
      setReferenceExpanded(false);
      setReferenceOpen(false);
    }
  };

  const bindImage = (image: TemplateContextCardBoundImage) => {
    if (!editingCard) return;
    updateCard(editingCard.id, { bound_image: image });
  };

  const handleDropOnCard = (targetCardId: string) => {
    if (!draggingCardId || draggingCardId === targetCardId) return;
    const dragging = sortedCards.find((card) => card.id === draggingCardId);
    if (!dragging) return;
    const withoutDragging = sortedCards.filter((card) => card.id !== draggingCardId);
    const targetIndex = withoutDragging.findIndex((card) => card.id === targetCardId);
    const next = [...withoutDragging];
    next.splice(targetIndex < 0 ? next.length : targetIndex, 0, dragging);
    onChange(reorderCards(next));
    setDraggingCardId(null);
  };

  const handleRewrite = async () => {
    if (!editingCard || !chatInput.trim()) return;
    setChatBusy(true);
    setChatError(null);
    try {
      const nextContent = await onRewriteCard(editingCard, chatInput.trim());
      updateCard(editingCard.id, { content: nextContent });
      setChatInput('');
    } catch (rewriteError) {
      setChatError(rewriteError instanceof Error ? rewriteError.message : 'LLM 修改失败');
    } finally {
      setChatBusy(false);
    }
  };

  const editHrefForCard = (card: TemplateContextCard) => (
    templateId ? `/admin/templates/${templateId}/cards/${card.id}` : null
  );

  const copyFinalPrompt = async () => {
    if (!finalPromptText) {
      setCopyNotice('暂无启用卡片');
      return;
    }
    try {
      await navigator.clipboard.writeText(finalPromptText);
      setCopyNotice('已复制最终提示词');
    } catch {
      setCopyNotice('复制失败，请展开后手动复制');
    }
  };

  const renderCardEditor = (className: string, showCloseButton: boolean) => {
    if (!editingCard) return (
      <section className={className} aria-label="编辑上下文卡片">
        <div className="template-card-edit-empty">
          <strong>没有找到这张卡片</strong>
          <span>它可能已经被删除，返回模板卡片列表重新选择。</span>
          {backHref && <Link href={backHref}>返回卡片列表</Link>}
        </div>
      </section>
    );

    return (
      <aside className={className} aria-label="编辑上下文卡片">
        <header>
          <div>
            <span>{modeLabel(editingCard.mode)}</span>
            <h3>{editingCard.title || '编辑上下文卡片'}</h3>
          </div>
          {showCloseButton && <button type="button" onClick={() => setInternalEditingCardId(null)}>关闭</button>}
        </header>
        <label>
          <span>卡片名称</span>
          <input value={editingCard.title} onChange={(event) => updateCard(editingCard.id, { title: event.currentTarget.value })} />
        </label>
        <label>
          <span>最终输入给 LLM 的上下文内容</span>
          <textarea
            value={editingCard.content}
            onChange={(event) => updateCard(editingCard.id, { content: event.currentTarget.value })}
            rows={8}
          />
        </label>
        <div className={`template-context-save ${saveStatus}`}>
          {saveStatusText(saveStatus, saveError)}
        </div>
        <div className="template-context-bound-row">
          <div>
            <span>绑定图片</span>
            <strong>{editingCard.bound_image?.label || '未绑定'}</strong>
          </div>
          <button type="button" onClick={() => setReferenceOpen(true)}>{editingCard.bound_image ? '更换图片' : '添加图片'}</button>
          {editingCard.bound_image && <button type="button" onClick={() => removeBoundImage(editingCard.id)}>移除图片</button>}
        </div>
        <section className="template-context-reference">
          <button type="button" onClick={() => setReferenceExpanded((current) => !current)}>
            {referenceExpanded ? '收起' : '展开'} LLM 参考与设置
          </button>
          {referenceExpanded && (
            <textarea
              value={editingCard.llm_reference}
              onChange={(event) => updateCard(editingCard.id, { llm_reference: event.currentTarget.value })}
              rows={5}
              placeholder="给 LLM 的背景、偏好或临时规则。"
            />
          )}
        </section>
        <section className="template-context-chat">
          <span>让 LLM 帮你改这张卡片</span>
          <textarea
            value={chatInput}
            onChange={(event) => setChatInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleRewrite();
              }
            }}
            rows={3}
            placeholder="例如：把这张卡片改得更强调角色性格，不要写成普通风格。"
          />
          <button type="button" onClick={() => { void handleRewrite(); }} disabled={chatBusy || !chatInput.trim()}>
            {chatBusy ? 'LLM 修改中...' : '发送并更新上方内容'}
          </button>
          {chatError && <div className="template-drawer-error">{chatError}</div>}
        </section>
        {editorActions && (
          <section className="template-context-editor-actions">
            {editorActions}
          </section>
        )}
      </aside>
    );
  };

  if (showCardEditorPage) {
    return (
      <section className="template-context-card-edit-page" aria-label="上下文卡片二级编辑页">
        <div className="template-card-edit-topbar">
          {backHref && <Link href={backHref}>返回卡片列表</Link>}
          <span>{saveStatusText(saveStatus, saveError)}</span>
        </div>
        {renderCardEditor('template-context-card-editor-page', false)}
        <TemplateBoundImagePicker
          open={referenceOpen}
          currentImage={editingCard?.bound_image || null}
          onClose={() => setReferenceOpen(false)}
          onSelect={bindImage}
        />
      </section>
    );
  }

  return (
    <section className="template-context-workspace" aria-label="模板上下文卡片">
      <div className={`template-context-edit-row ${showInlineEditor && editingCard ? 'is-editing' : ''}`}>
        <div className="template-context-main">
          <div className="template-context-toolbar">
            <div>
              <h3>上下文卡片</h3>
              <p>拖动排序，决定最终提示词读取顺序。</p>
            </div>
            <button type="button" className="template-context-add" onClick={addCard}>
              <Plus size={16} aria-hidden="true" />
              新增上下文卡片
            </button>
          </div>

          {sortedCards.length === 0 ? (
            <div className="template-context-empty">
              <strong>还没有上下文卡片</strong>
              <span>先添加一张卡片告诉 LLM 什么必须保持。</span>
              <button type="button" onClick={addCard}>添加卡片</button>
            </div>
          ) : (
            <div className="template-context-card-list">
              {sortedCards.map((card) => (
                <article
                  key={card.id}
                  className={[
                    'template-context-card',
                    card.enabled ? '' : 'is-disabled',
                    draggingCardId === card.id ? 'is-dragging' : '',
                  ].filter(Boolean).join(' ')}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => handleDropOnCard(card.id)}
                >
                  <span
                    className="template-context-drag"
                    draggable
                    onDragStart={() => setDraggingCardId(card.id)}
                    onDragEnd={() => setDraggingCardId(null)}
                    aria-label="拖动排序"
                    title="拖动排序"
                  >
                    <GripVertical size={18} />
                  </span>
                  {editHrefForCard(card) ? (
                    <Link
                      className="template-context-thumb"
                      href={editHrefForCard(card) || '#'}
                      title={card.bound_image ? '编辑绑定图片' : '添加图片'}
                    >
                      {card.bound_image?.thumbnail_url || card.bound_image?.url ? (
                        <img src={card.bound_image.thumbnail_url || card.bound_image.url || ''} alt={card.bound_image.label} />
                      ) : (
                        <span><ImageIcon size={18} /> 添加图片</span>
                      )}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="template-context-thumb"
                      onClick={() => {
                        setInternalEditingCardId(card.id);
                        setReferenceOpen(true);
                      }}
                      title={card.bound_image ? '更换绑定图片' : '添加图片'}
                    >
                    {card.bound_image?.thumbnail_url || card.bound_image?.url ? (
                      <img src={card.bound_image.thumbnail_url || card.bound_image.url || ''} alt={card.bound_image.label} />
                    ) : (
                      <span><ImageIcon size={18} /> 添加图片</span>
                    )}
                    </button>
                  )}
                  <div className="template-context-card-body">
                    <div className="template-context-card-title">
                      <strong>{card.title || '未命名卡片'}</strong>
                      <span>{card.bound_image ? `已绑定图片：${card.bound_image.label}` : '未绑定图片'}</span>
                    </div>
                    <p>{card.content || '还没有写入给 LLM 的上下文内容。'}</p>
                    <div className="template-context-card-controls">
                      <button
                        type="button"
                        className={card.mode === 'force' ? 'is-active' : ''}
                        onClick={() => updateCard(card.id, { mode: 'force' })}
                      >
                        强制插入
                      </button>
                      <button
                        type="button"
                        className={card.mode === 'reference' ? 'is-active' : ''}
                        onClick={() => updateCard(card.id, { mode: 'reference' })}
                      >
                        仅供参考
                      </button>
                    </div>
                  </div>
                  <div className="template-context-card-actions">
                    <button
                      type="button"
                      className={card.enabled ? 'is-enabled' : ''}
                      onClick={() => updateCard(card.id, { enabled: !card.enabled })}
                    >
                      {card.enabled ? '启用' : '停用'}
                    </button>
                    {editHrefForCard(card) ? (
                      <Link href={editHrefForCard(card) || '#'}>编辑</Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setInternalEditingCardId(card.id);
                          setReferenceExpanded(false);
                        }}
                      >
                        编辑
                      </button>
                    )}
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => deleteCard(card.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        {showInlineEditor && editingCard && renderCardEditor('template-context-drawer', true)}
      </div>

      <aside className="template-context-impact" aria-label="最终提示词影响预览">
        <header className="template-context-impact-head">
          <div>
            <span>最终提示词影响</span>
            <strong>{enabledCards.length} 张启用卡片</strong>
          </div>
          <button type="button" onClick={copyFinalPrompt}>复制最终提示词</button>
        </header>
        <dl className="template-context-impact-stats">
          <div><dt>强制插入</dt><dd>{forceCount}</dd></div>
          <div><dt>仅供参考</dt><dd>{referenceCount}</dd></div>
          <div><dt>绑定图片</dt><dd>{imageCount}</dd></div>
        </dl>
        <div className="template-context-impact-columns">
          <section>
            <h4>强制写入</h4>
            <ol>
              {forceCards.length ? forceCards.map((card) => (
                <li key={card.id}>
                  <strong>{card.title}</strong>
                  <span>{card.content || '草稿未写内容'}</span>
                </li>
              )) : <li><span>暂无强制插入卡片</span></li>}
            </ol>
          </section>
          <section>
            <h4>仅供参考</h4>
            <ol>
              {referenceCards.length ? referenceCards.map((card) => (
                <li key={card.id}>
                  <strong>{card.title}</strong>
                  <span>{card.content || '草稿未写内容'}</span>
                </li>
              )) : <li><span>暂无参考卡片</span></li>}
            </ol>
          </section>
          <section>
            <h4>绑定图片</h4>
            <ol>
              {boundImageCards.length ? boundImageCards.map((card) => (
                <li key={card.id}>
                  <strong>{card.bound_image?.label || card.title}</strong>
                  <span>{card.title} · {card.bound_image?.source === 'upload_history' ? '历史上传图' : '参考图集'}</span>
                </li>
              )) : <li><span>暂无绑定图片</span></li>}
            </ol>
          </section>
        </div>
        {copyNotice && <div className="template-context-copy-state">{copyNotice}</div>}
        <details>
          <summary>查看完整最终提示词</summary>
          <pre>{finalPromptText || '暂无启用卡片'}</pre>
        </details>
      </aside>

      <TemplateBoundImagePicker
        open={referenceOpen}
        currentImage={editingCard?.bound_image || null}
        onClose={() => setReferenceOpen(false)}
        onSelect={bindImage}
      />
    </section>
  );
}
