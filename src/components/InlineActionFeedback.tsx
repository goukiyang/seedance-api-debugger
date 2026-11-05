'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

type ActionFeedback = { text: string; failed?: boolean };

export function useInlineActionFeedback() {
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  useEffect(() => {
    if (!feedback || feedback.failed) return;
    const timer = window.setTimeout(() => setFeedback(null), 2400);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  return { feedback, setFeedback };
}

export function InlineActionFeedback({ children, feedback }: { children: ReactNode; feedback: ActionFeedback | null }) {
  return <span className="sd2-action-feedback">
    {children}
    <span role="status" aria-atomic="true" className="sd2-action-feedback-message" data-visible={Boolean(feedback)} data-failed={feedback?.failed}>
      {feedback?.text}
    </span>
  </span>;
}

export function CopyTextButton({ text, label, className, iconOnly = false, errorMessage = '复制未完成，请重试' }: {
  text: string; label: string; className?: string; iconOnly?: boolean; errorMessage?: string;
}) {
  const { feedback, setFeedback } = useInlineActionFeedback();
  const [copying, setCopying] = useState(false);
  async function copy() {
    setCopying(true);
    setFeedback(null);
    try {
      await navigator.clipboard.writeText(text);
      setFeedback({ text: '已复制' });
    } catch {
      setFeedback({ text: errorMessage, failed: true });
    } finally {
      setCopying(false);
    }
  }
  const Icon = feedback && !feedback.failed ? Check : Copy;
  return <InlineActionFeedback feedback={feedback}>
    <button type="button" className={className} aria-label={label} title={iconOnly ? label : undefined} disabled={copying} onClick={() => void copy()}>
      <Icon size={15} aria-hidden="true" />{iconOnly ? null : label}
    </button>
  </InlineActionFeedback>;
}
