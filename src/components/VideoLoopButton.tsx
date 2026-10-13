'use client';

import { Repeat2 } from 'lucide-react';
import styles from './VideoLoopButton.module.css';

type Props = {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
  storageUnavailable?: boolean;
  synchronized?: boolean;
  className?: string;
};

export function VideoLoopButton({ enabled, onToggle, disabled, storageUnavailable, synchronized, className }: Props) {
  const label = synchronized ? '同步循环' : '循环';
  return <span className={`${styles.control} ${className || ''}`} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <button type="button" className={styles.button} aria-pressed={enabled} disabled={disabled}
      title={disabled ? '暂无可播放视频' : '只循环当前视频；手机系统全屏中请先退出全屏再调整'}
      onClick={event => { event.stopPropagation(); onToggle(); }}>
      <Repeat2 size={15} aria-hidden="true" />{label}{enabled ? '已开' : ''}
    </button>
    {storageUnavailable && <small className={styles.notice} role="status">本次设置无法记住</small>}
  </span>;
}
