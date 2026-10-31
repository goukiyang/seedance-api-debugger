'use client';
import { useEffect, useState } from 'react';
import type { RetryRule } from '@/lib/generation-retry/contracts';
export default function RetryRules() {
  const [config, setConfig] = useState<{ revision: string; enabledIds: string[]; rules: RetryRule[] } | null>(null);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true;
    fetch('/api/admin/integrations/generation-retry', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error(); const value = await response.json(); if (active) setConfig(value);
    }).catch(() => { if (active) setMessage('重试规则暂不可读'); });
    return () => { active = false; };
  }, []);
  return <section style={{ borderTop: '1px solid #d1d5db', marginTop: 24, paddingTop: 16 }}>
    <h2 style={{ fontSize: 18 }}>安全自动重试</h2>
    {message && <p role="status">{message}</p>}
    {config && <><p>最多追加 3 次 · 已核实规则 {config.rules.length} 条</p>
      {config.rules.length === 0 && <p>暂无已核实规则</p>}
      {config.rules.map(rule => <label key={rule.id} style={{ display: 'block' }}><input type="checkbox" disabled={busy}
        checked={config.enabledIds.includes(rule.id)} onChange={event => setConfig({ ...config, enabledIds: event.target.checked
          ? [...config.enabledIds, rule.id] : config.enabledIds.filter(id => id !== rule.id) })} />
        {rule.scope.provider} / {rule.scope.model} / {rule.code} / {rule.version} <a href={rule.evidence} target="_blank" rel="noreferrer">合同依据</a></label>)}
      {config.rules.length > 0 && <button type="button" className="btn btn-secondary" disabled={busy} onClick={async () => {
        setBusy(true); try {
          const response = await fetch('/api/admin/integrations/generation-retry', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: config.revision, enabledIds: config.enabledIds }) });
          const result = await response.json(); if (!response.ok) throw new Error(result.error);
          setConfig({ ...config, ...result }); setMessage('规则已保存');
        } catch (error) { setMessage(error instanceof Error ? error.message : '规则未保存'); } finally { setBusy(false); }
      }}>保存重试规则</button>}
    </>}
  </section>;
}
