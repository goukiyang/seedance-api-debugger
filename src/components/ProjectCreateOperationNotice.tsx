'use client';

import { CircleCheck, RefreshCw } from 'lucide-react';
import type { ProjectCreateOperation, ProjectCreateResult } from '@/lib/projects/client-operations';

export default function ProjectCreateOperationNotice({ operation, onResolved }: {
  operation: ProjectCreateOperation;
  onResolved?: (result: ProjectCreateResult) => void | Promise<void>;
}) {
  const message = operation.lastResult?.operation.state === 'closed' ? '本次创建已结束，输入保留，可主动重新创建。'
    : operation.lastResult?.operation.state === 'accepted' && !operation.lastResult.project
      ? '原创建已受理，当前项目已不可访问；没有重新创建。' : '';
  if (!operation.pending && !operation.error && !message) return null;
  async function run(action: 'check' | 'close') {
    try {
      const result = await operation[action]();
      await onResolved?.(result);
    } catch { /* The hook retains the original request and its readable error. */ }
  }
  return <section className="composer-project-message info" aria-label="项目创建状态" aria-live="polite">
    {operation.pending && <p>“{operation.pending.input.name}”的创建结果待确认。仅本次创建暂时锁定，其它工作可继续。</p>}
    {(operation.error || message) && <p role="status">{operation.error || message}</p>}
    {operation.pending ? <div className="inline-actions">
      <button type="button" className="btn btn-secondary" disabled={operation.busy} onClick={() => void run('check')}><RefreshCw size={15} />查询原创建</button>
      <button type="button" className="btn btn-secondary" disabled={operation.busy} onClick={() => void run('close')}><CircleCheck size={15} />核对并结束本次创建</button>
    </div> : !operation.ready && <button type="button" className="btn btn-secondary" onClick={operation.restore}>重新读取</button>}
  </section>;
}
