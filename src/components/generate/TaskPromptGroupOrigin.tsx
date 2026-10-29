'use client';
import { useEffect, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { PromptGroupHistory } from './PromptGroupPicker';
import { parseVideoPromptGroupRefs, type VideoPromptGroupRef } from '@/lib/video/prompt-groups';
export function TaskPromptGroupOrigin({ taskId }: { taskId: string | null }) {
  const { user, sessionChanged } = useAppSession();
  const key = JSON.stringify([user?.id, taskId, sessionChanged]);
  const [state, setState] = useState<{ key: string; refs: VideoPromptGroupRef[] }>({ key: '', refs: [] });
  useEffect(() => {
    if (!taskId || !user?.id || sessionChanged) return;
    const controller = new AbortController();
    void fetch(`/api/tasks/${encodeURIComponent(taskId)}/prompt-groups`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const data = await response.json();
      if (!controller.signal.aborted) setState({ key, refs: parseVideoPromptGroupRefs(data.refs) });
    }).catch(() => undefined);
    return () => controller.abort();
  }, [key, taskId, user?.id, sessionChanged]);
  return state.key === key && state.refs.length ? <PromptGroupHistory refs={state.refs} label="生成来源 · 提示词组" /> : null;
}
