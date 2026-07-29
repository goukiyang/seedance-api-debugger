'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ImagePlus, Maximize2, X } from 'lucide-react';
import { PromptMentionPopover, type PromptMentionCandidate } from '@/components/PromptMentionPopover';
import {
  detectMentionAtCursor,
  replaceMentionRange,
  type PromptMentionRange,
} from '@/lib/prompt/mention';

interface ReferenceLabel {
  label: string;
  title: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onFormat?: () => void;
  referenceLabels?: ReferenceLabel[];
  onInsertReferenceLabel?: (label: string) => void;
  mentionCandidates?: PromptMentionCandidate[];
  onMentionSelect?: (candidate: PromptMentionCandidate) => Promise<string | null | undefined> | string | null | undefined;
}

const MAX_CHARS = 2000;
const PROMPT_TEXTAREA_MAX_HEIGHT = 320;
const PROMPT_TEXTAREA_MOBILE_MAX_HEIGHT = 280;
const MOBILE_QUERY = '(max-width: 640px)';

function insertTextAtRange(value: string, insertText: string, start: number, end: number) {
  const next = `${value.slice(0, start)}${insertText}${value.slice(end)}`;
  return {
    next,
    cursor: start + insertText.length,
  };
}

function getPromptTextareaMaxHeight() {
  if (typeof window === 'undefined') return PROMPT_TEXTAREA_MAX_HEIGHT;
  return window.matchMedia(MOBILE_QUERY).matches ? PROMPT_TEXTAREA_MOBILE_MAX_HEIGHT : PROMPT_TEXTAREA_MAX_HEIGHT;
}

function fitTextareaHeight(textarea: HTMLTextAreaElement) {
  const maxHeight = getPromptTextareaMaxHeight();
  textarea.style.height = 'auto';
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

export function PromptEditor({
  value,
  onChange,
  onFormat,
  referenceLabels = [],
  onInsertReferenceLabel,
  mentionCandidates = [],
  onMentionSelect,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const expandedTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(value);
  const [mentionState, setMentionState] = useState<{
    target: 'main' | 'expanded';
    range: PromptMentionRange;
  } | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const activeMentionIndexRef = useRef(0);
  const [mentionLoading, setMentionLoading] = useState(false);

  const hasReferences = referenceLabels.length > 0;
  const canOpenExpanded = value.length <= MAX_CHARS;
  const visibleMentionCandidates = useMemo(() => {
    if (!mentionState) return [];
    const query = mentionState.range.query.trim().toLowerCase();
    if (!query) return mentionCandidates;
    return mentionCandidates.filter((candidate) => {
      const haystack = [
        candidate.label,
        candidate.type === 'image' ? candidate.token : '',
        candidate.type === 'image' ? candidate.title : '',
        candidate.description || '',
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [mentionCandidates, mentionState]);
  const showMentionMenu = Boolean(mentionState) && visibleMentionCandidates.length > 0;

  const resizeMainTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    fitTextareaHeight(textarea);
  }, []);

  const updateMentionState = useCallback((target: 'main' | 'expanded', text: string, cursor: number | null) => {
    const range = detectMentionAtCursor(text, cursor);
    if (!range) {
      setMentionState(null);
      setActiveMentionIndex(0);
      activeMentionIndexRef.current = 0;
      return;
    }
    setMentionState({ target, range });
    setActiveMentionIndex(0);
    activeMentionIndexRef.current = 0;
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    if (text.length <= MAX_CHARS) {
      onChange(text);
      updateMentionState('main', text, e.target.selectionStart);
    }
  }, [onChange, updateMentionState]);

  const handleDraftChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    if (text.length <= MAX_CHARS) {
      setDraft(text);
      updateMentionState('expanded', text, e.target.selectionStart);
    }
  }, [updateMentionState]);

  const focusTextareaAt = useCallback((ref: React.RefObject<HTMLTextAreaElement>, cursor: number) => {
    window.requestAnimationFrame(() => {
      const textarea = ref.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  }, []);

  const insertMainReference = useCallback((label: string) => {
    const marker = `@${label}`;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? start;
    const { next, cursor } = insertTextAtRange(value, marker, start, end);
    if (next.length > MAX_CHARS) return;
    onChange(next);
    onInsertReferenceLabel?.(label);
    focusTextareaAt(textareaRef, cursor);
  }, [focusTextareaAt, onChange, onInsertReferenceLabel, value]);

  const insertDraftReference = useCallback((label: string) => {
    const marker = `@${label}`;
    const textarea = expandedTextareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? start;
    const { next, cursor } = insertTextAtRange(draft, marker, start, end);
    if (next.length > MAX_CHARS) return;
    setDraft(next);
    focusTextareaAt(expandedTextareaRef, cursor);
  }, [draft, focusTextareaAt]);

  const applyMentionInsert = useCallback((
    target: 'main' | 'expanded',
    range: PromptMentionRange,
    insertText: string,
  ) => {
    if (!insertText.trim()) return;
    if (target === 'main') {
      const { next, cursor } = replaceMentionRange(value, range, insertText);
      if (next.length > MAX_CHARS) return;
      onChange(next);
      focusTextareaAt(textareaRef, cursor);
      return;
    }

    const { next, cursor } = replaceMentionRange(draft, range, insertText);
    if (next.length > MAX_CHARS) return;
    setDraft(next);
    focusTextareaAt(expandedTextareaRef, cursor);
  }, [draft, focusTextareaAt, onChange, value]);

  const selectMentionCandidate = useCallback(async (candidate: PromptMentionCandidate) => {
    if (!mentionState || candidate.disabled) return;
    const currentMention = mentionState;
    const fallbackToken = candidate.type === 'image' ? candidate.token : null;
    setMentionLoading(true);
    try {
      const resolvedToken = await onMentionSelect?.(candidate);
      const insertText = resolvedToken || fallbackToken;
      if (insertText) {
        applyMentionInsert(currentMention.target, currentMention.range, insertText);
      }
      setMentionState(null);
      setActiveMentionIndex(0);
      activeMentionIndexRef.current = 0;
    } finally {
      setMentionLoading(false);
    }
  }, [applyMentionInsert, mentionState, onMentionSelect]);

  const selectActiveMentionCandidate = useCallback(() => {
    if (!showMentionMenu || visibleMentionCandidates.length === 0) return;
    const enabledCandidates = visibleMentionCandidates.filter((candidate) => !candidate.disabled);
    if (enabledCandidates.length === 0) return;
    const currentIndex = activeMentionIndexRef.current;
    const candidate = visibleMentionCandidates[currentIndex] && !visibleMentionCandidates[currentIndex].disabled
      ? visibleMentionCandidates[currentIndex]
      : enabledCandidates[0];
    void selectMentionCandidate(candidate);
  }, [selectMentionCandidate, showMentionMenu, visibleMentionCandidates]);

  const handleMentionKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>, target: 'main' | 'expanded') => {
    if (!mentionState || mentionState.target !== target) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMentionState(null);
      setActiveMentionIndex(0);
      activeMentionIndexRef.current = 0;
      return true;
    }
    if (!showMentionMenu) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveMentionIndex((index) => {
        const next = (index + 1) % visibleMentionCandidates.length;
        activeMentionIndexRef.current = next;
        return next;
      });
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveMentionIndex((index) => {
        const next = (index - 1 + visibleMentionCandidates.length) % visibleMentionCandidates.length;
        activeMentionIndexRef.current = next;
        return next;
      });
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectActiveMentionCandidate();
      return true;
    }
    return false;
  }, [mentionState, selectActiveMentionCandidate, showMentionMenu, visibleMentionCandidates.length]);

  const openExpanded = useCallback(() => {
    setDraft(value);
    setExpanded(true);
    setMentionState(null);
  }, [value]);

  const closeExpanded = useCallback(() => {
    if (draft !== value) {
      const ok = window.confirm('放弃本次提示词编辑？');
      if (!ok) return;
    }
    setExpanded(false);
    setMentionState(null);
  }, [draft, value]);

  const commitExpanded = useCallback(() => {
    onChange(draft);
    setExpanded(false);
    setMentionState(null);
  }, [draft, onChange]);

  useLayoutEffect(() => {
    resizeMainTextarea();
  }, [resizeMainTextarea, value]);

  useEffect(() => {
    const handleResize = () => resizeMainTextarea();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [resizeMainTextarea]);

  useEffect(() => {
    if (!expanded) return;
    window.requestAnimationFrame(() => {
      const textarea = expandedTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      const cursor = textarea.value.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeExpanded();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeExpanded, expanded]);

  const referenceButtons = useMemo(() => {
    if (!hasReferences) {
      return (
        <button type="button" className="composer-reference-button" disabled>
          先上传或选择图片
        </button>
      );
    }

    return referenceLabels.map((item) => (
      <button
        key={item.label}
        type="button"
        className="composer-reference-button"
        title={item.title}
        onClick={() => insertMainReference(item.label)}
      >
        <ImagePlus size={13} aria-hidden="true" />
        @{item.label}
      </button>
    ));
  }, [hasReferences, insertMainReference, referenceLabels]);

  const expandedReferenceButtons = useMemo(() => {
    if (!hasReferences) {
      return (
        <button type="button" className="composer-reference-button" disabled>
          先上传或选择图片
        </button>
      );
    }

    return referenceLabels.map((item) => (
      <button
        key={item.label}
        type="button"
        className="composer-reference-button"
        title={item.title}
        onClick={() => insertDraftReference(item.label)}
      >
        <ImagePlus size={13} aria-hidden="true" />
        @{item.label}
      </button>
    ));
  }, [hasReferences, insertDraftReference, referenceLabels]);

  return (
    <div className="composer-prompt-editor">
      <textarea
        ref={textareaRef}
        className="composer-prompt-textarea"
        value={value}
        onChange={handleChange}
        onKeyDown={(event) => { handleMentionKeyDown(event, 'main'); }}
        onSelect={(event) => updateMentionState('main', event.currentTarget.value, event.currentTarget.selectionStart)}
        maxLength={MAX_CHARS}
        placeholder="描述你想生成的视频内容，可输入 @ 选择当前图片参考或历史素材……"
        rows={4}
      />
      {mentionState?.target === 'main' && (
        <PromptMentionPopover
          candidates={visibleMentionCandidates}
          activeIndex={activeMentionIndex}
          loading={mentionLoading}
          onActiveIndexChange={(index) => {
            activeMentionIndexRef.current = index;
            setActiveMentionIndex(index);
          }}
          onSelect={(candidate) => { void selectMentionCandidate(candidate); }}
        />
      )}

      <div className="composer-prompt-footer">
        <div className="composer-prompt-tools">
          <div className="composer-prompt-hint">
            即梦规则：用 @图片1 指代当前第 1 个图片参考；音频会自动作为参考音频传入
          </div>
          <div className="composer-reference-buttons">
            {referenceButtons}
          </div>
        </div>
        <div className="composer-prompt-actions">
          <button
            type="button"
            className="composer-prompt-tool-button"
            onClick={openExpanded}
            disabled={!canOpenExpanded}
          >
            <Maximize2 size={13} aria-hidden="true" />
            放大编辑
          </button>
          <div className="composer-prompt-counter">
            {value.length} / {MAX_CHARS}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="composer-prompt-expanded-overlay" role="dialog" aria-modal="true" aria-label="提示词编辑">
          <div className="composer-prompt-expanded-panel">
            <div className="composer-prompt-expanded-head">
              <div>
                <span>提示词编辑</span>
                <strong>{draft.length} / {MAX_CHARS}</strong>
              </div>
              <button type="button" className="composer-prompt-icon-button" onClick={closeExpanded} aria-label="关闭提示词编辑">
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="composer-reference-buttons composer-reference-buttons-expanded">
              {expandedReferenceButtons}
            </div>

            <div className="composer-prompt-expanded-editor">
              <textarea
                ref={expandedTextareaRef}
                className="composer-prompt-expanded-textarea"
                value={draft}
                onChange={handleDraftChange}
                onKeyDown={(event) => { handleMentionKeyDown(event, 'expanded'); }}
                onSelect={(event) => updateMentionState('expanded', event.currentTarget.value, event.currentTarget.selectionStart)}
                maxLength={MAX_CHARS}
                placeholder="描述你想生成的视频内容，可输入 @ 选择当前图片参考或历史素材……"
              />
              {mentionState?.target === 'expanded' && (
                <PromptMentionPopover
                  candidates={visibleMentionCandidates}
                  activeIndex={activeMentionIndex}
                  loading={mentionLoading}
                  onActiveIndexChange={(index) => {
                    activeMentionIndexRef.current = index;
                    setActiveMentionIndex(index);
                  }}
                  onSelect={(candidate) => { void selectMentionCandidate(candidate); }}
                />
              )}
            </div>

            <div className="composer-prompt-expanded-actions">
              <button type="button" className="composer-prompt-tool-button" onClick={closeExpanded}>
                <X size={14} aria-hidden="true" />
                取消
              </button>
              <button type="button" className="composer-prompt-confirm-button" onClick={commitExpanded}>
                <Check size={14} aria-hidden="true" />
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
