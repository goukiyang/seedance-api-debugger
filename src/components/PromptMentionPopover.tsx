'use client';

/* eslint-disable @next/next/no-img-element */
import { FolderOpen, History, Image as ImageIcon, Plus } from 'lucide-react';

export type PromptMentionCandidate =
  | {
      id: string;
      type: 'action';
      action: 'create_subject';
      label: string;
      description?: string;
      disabled?: boolean;
    }
  | {
      id: string;
      type: 'image';
      token: string;
      label: string;
      title: string;
      description?: string;
      thumbnailUrl?: string | null;
      referenceImageId?: string | null;
      assetId?: string | null;
      disabled?: boolean;
    }
  | {
      id: string;
      type: 'source';
      source: 'history' | 'album';
      label: string;
      description?: string;
      disabled?: boolean;
    };

interface Props {
  candidates: PromptMentionCandidate[];
  activeIndex: number;
  loading?: boolean;
  emptyText?: string;
  onActiveIndexChange?: (index: number) => void;
  onSelect: (candidate: PromptMentionCandidate) => void;
}

function CandidateIcon({ candidate }: { candidate: PromptMentionCandidate }) {
  if (candidate.type === 'image') {
    if (candidate.thumbnailUrl) {
      return <img src={candidate.thumbnailUrl} alt={candidate.label} />;
    }
    return (
      <span className="prompt-mention-icon">
        <ImageIcon size={15} aria-hidden="true" />
      </span>
    );
  }
  if (candidate.type === 'source') {
    return (
      <span className="prompt-mention-icon">
        {candidate.source === 'history' ? <History size={15} aria-hidden="true" /> : <FolderOpen size={15} aria-hidden="true" />}
      </span>
    );
  }
  return (
    <span className="prompt-mention-icon">
      <Plus size={16} aria-hidden="true" />
    </span>
  );
}

function getCandidateMeta(candidate: PromptMentionCandidate) {
  if (candidate.type === 'image') return candidate.description || candidate.title;
  return candidate.description || '';
}

export function PromptMentionPopover({
  candidates,
  activeIndex,
  loading = false,
  emptyText = '没有匹配的内容',
  onActiveIndexChange,
  onSelect,
}: Props) {
  return (
    <div className="prompt-mention-popover" role="listbox" aria-label="可能@的内容">
      <div className="prompt-mention-title">可能@的内容</div>
      {loading ? (
        <div className="prompt-mention-empty">读取中...</div>
      ) : candidates.length === 0 ? (
        <div className="prompt-mention-empty">{emptyText}</div>
      ) : (
        candidates.map((candidate, index) => {
          const meta = getCandidateMeta(candidate);
          return (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              disabled={candidate.disabled}
              className={[
                'prompt-mention-option',
                index === activeIndex ? 'active' : '',
                candidate.disabled ? 'disabled' : '',
                candidate.type === 'action' ? 'action' : '',
              ].filter(Boolean).join(' ')}
              onMouseEnter={() => onActiveIndexChange?.(index)}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!candidate.disabled) onSelect(candidate);
              }}
            >
              <CandidateIcon candidate={candidate} />
              <span className="prompt-mention-main">
                <b>{candidate.type === 'image' ? candidate.token : candidate.label}</b>
                {meta && <small>{meta}</small>}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
