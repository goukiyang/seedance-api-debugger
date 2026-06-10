'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ImagePlus, Maximize2, X } from 'lucide-react';

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
}

const MAX_CHARS = 2000;

function insertTextAtRange(value: string, insertText: string, start: number, end: number) {
  const next = `${value.slice(0, start)}${insertText}${value.slice(end)}`;
  return {
    next,
    cursor: start + insertText.length,
  };
}

export function PromptEditor({
  value,
  onChange,
  onFormat,
  referenceLabels = [],
  onInsertReferenceLabel,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const expandedTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(value);

  const hasReferences = referenceLabels.length > 0;
  const canOpenExpanded = value.length <= MAX_CHARS;

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    if (text.length <= MAX_CHARS) {
      onChange(text);
    }
  }, [onChange]);

  const handleDraftChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    if (text.length <= MAX_CHARS) {
      setDraft(text);
    }
  }, []);

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

  const openExpanded = useCallback(() => {
    setDraft(value);
    setExpanded(true);
  }, [value]);

  const closeExpanded = useCallback(() => {
    if (draft !== value) {
      const ok = window.confirm('放弃本次提示词编辑？');
      if (!ok) return;
    }
    setExpanded(false);
  }, [draft, value]);

  const commitExpanded = useCallback(() => {
    onChange(draft);
    setExpanded(false);
  }, [draft, onChange]);

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
        maxLength={MAX_CHARS}
        placeholder="描述你想生成的视频内容，可使用 @图片1、@图片2 引用当前素材……"
        rows={4}
      />

      <div className="composer-prompt-footer">
        <div className="composer-prompt-tools">
          <div className="composer-prompt-hint">
            即梦规则：用 @图片1 指代当前第 1 张参考图
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

            <textarea
              ref={expandedTextareaRef}
              className="composer-prompt-expanded-textarea"
              value={draft}
              onChange={handleDraftChange}
              maxLength={MAX_CHARS}
              placeholder="描述你想生成的视频内容，可使用 @图片1、@图片2 引用当前素材……"
            />

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
