import type { HTMLAttributes, ReactNode } from 'react';
import { X } from 'lucide-react';

export function ExperienceActions({ label, className, children, ...events }: HTMLAttributes<HTMLDivElement> & {
  label: string; children: ReactNode;
}) {
  return <div {...events} className={['exp-actions', className].filter(Boolean).join(' ')} role="group" aria-label={label}>{children}</div>;
}

export function SelectionBar({ count, summary, selection, children, className }: {
  count: number; summary?: ReactNode; selection?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={['exp-selection', className].filter(Boolean).join(' ')} aria-label="批量操作" data-selected={count > 0}>
    {selection}
    <div className="exp-selection-summary">
      <strong role="status">已选 {count} 个</strong>{summary && <small>{summary}</small>}
    </div>
    <ExperienceActions label="处理已选项">{children}</ExperienceActions>
  </section>;
}

export type ExperienceFilter = { id: string; label: string; remove: () => void };

export function FilterSummary({ filters, clear, disabled = false }: { filters: ExperienceFilter[]; clear?: () => void; disabled?: boolean }) {
  if (!filters.length) return null;
  return <div className="exp-filters" role="group" aria-label="当前筛选">
    {filters.map(({ id, label, remove }) => <button key={id} type="button" className="exp-filter" title={label}
      aria-label={`移除筛选：${label}`} disabled={disabled} onClick={remove}><span>{label}</span><X size={13} aria-hidden="true" /></button>)}
    {clear && filters.length > 1 && <button type="button" className="exp-filter-clear" disabled={disabled} onClick={clear}>清除筛选</button>}
  </div>;
}

export function ExperienceEmpty({ title, description, children, className }: {
  title: string; description?: ReactNode; children?: ReactNode; className?: string;
}) {
  return <div className={['exp-empty', className].filter(Boolean).join(' ')}>
    <strong>{title}</strong>
    {description && <p>{description}</p>}
    {children && <ExperienceActions label="下一步">{children}</ExperienceActions>}
  </div>;
}

export function OperationReceipt({ status, actions, detail, busy, className }: {
  status: ReactNode; actions?: ReactNode; detail?: ReactNode; busy?: boolean; className?: string;
}) {
  return <div className={['exp-receipt', className].filter(Boolean).join(' ')} aria-busy={busy || undefined}>
    <span role="status" className="exp-receipt-status">{status}</span>
    {actions && <ExperienceActions label="查看或继续原操作">{actions}</ExperienceActions>}
    {detail && <div className="exp-receipt-detail">{detail}</div>}
  </div>;
}
