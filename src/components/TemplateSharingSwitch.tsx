'use client';
import styles from './TemplateSharingSwitch.module.css';

export default function TemplateSharingSwitch({ shared, selected = false, disabled, pending, name = '', className = '', onChange }: {
  shared: boolean; selected?: boolean; disabled?: boolean; pending?: boolean; name?: string; className?: string;
  onChange: (anchor: HTMLInputElement) => void;
}) {
  const tip = pending ? '共享结果待确认，点击核对原操作'
    : shared ? '已共享给同事，点击停止共享'
    : selected ? '已选择共享，保存模板后生效' : '仅自己可见，点击共享给同事';
  return <label className={`toggle-switch ${styles.switch} ${className}`} title={tip} data-tip={tip}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <input type="checkbox" role="switch" aria-label={`${name ? `${name}：` : ''}${tip}`} aria-busy={pending || undefined}
      checked={shared || selected} disabled={disabled} onChange={event => onChange(event.currentTarget)} />
    <span className="toggle-slider" />
  </label>;
}
