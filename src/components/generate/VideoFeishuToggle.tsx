'use client';

import { RefreshCw } from 'lucide-react';
import type { useVideoFeishu } from '@/lib/hooks/use-video-feishu';
import styles from './video-feishu.module.css';

export function VideoFeishuToggle({ state, disabled, label = '成品发到本人飞书' }: { state: ReturnType<typeof useVideoFeishu>; disabled: boolean; label?: string }) {
  return <div className={styles.setting}>
    <label className={styles.label}><span>{label}</span><span className="toggle-switch" title={!state.ready ? '正在读取设置' : !state.available ? '当前账号暂不能发送到飞书' : '仅用于本页新提交任务'}>
      <input type="checkbox" role="switch" aria-label={label} checked={state.enabled} disabled={disabled || state.busy || !state.ready || !state.available && !state.enabled}
        onChange={event => void state.change(event.target.checked)} /><span className="toggle-slider" /></span></label>
    {state.busy && <span className={styles.notice} role="status">正在核对设置…</span>}
    {(state.error || state.ready && !state.available) && <div className={styles.notice} role="status"><span>{state.error ? `${state.error}；本次新任务暂不发送飞书` : '当前账号暂不能发送到飞书'}</span>
      {state.error && <><button type="button" title="重新读取设置" aria-label="重新读取飞书设置" disabled={disabled || state.busy} onClick={() => void state.read()}><RefreshCw size={14} /></button>
        {state.unsaved && <button type="button" disabled={disabled || state.busy} onClick={() => void state.retry()}>保存本次选择</button>}</>}</div>}
  </div>;
}
