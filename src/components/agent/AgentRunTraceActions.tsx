'use client';

import { useEffect, useMemo, useState } from 'react';
import { refreshPage } from '@/lib/hooks/page-exit-guard';

type Props = {
  traceId: string;
  report: unknown;
};

export function AgentRunTraceActions({ traceId, report }: Props) {
  const [copied, setCopied] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshPaused, setRefreshPaused] = useState(false);
  const reportText = useMemo(() => JSON.stringify(report, null, 2), [report]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      if (!refreshPage()) { setAutoRefresh(false); setRefreshPaused(true); }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(traceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const href = `data:application/json;charset=utf-8,${encodeURIComponent(reportText)}`;

  return (
    <div className="admin-agent-runs-actions">
      <button type="button" onClick={handleCopy}>{copied ? '已复制 Trace ID' : '复制 Trace ID'}</button>
      <a href={href} download={`agent-run-${traceId}.json`}>导出报告</a>
      {refreshPaused && <span role="status">有未保存内容或操作进行中，自动刷新已暂停。</span>}
      <button type="button" className={autoRefresh ? 'is-active' : ''} onClick={() => { setRefreshPaused(false); setAutoRefresh((value) => !value); }}>
        {autoRefresh ? '自动刷新中' : '自动刷新'}
      </button>
    </div>
  );
}
