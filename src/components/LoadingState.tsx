import type { ReactNode } from 'react';

export function LoadingStatus({ children }: { children: ReactNode }) {
  return <div className="sd2-loading-status sd2-loading-surface" data-busy="true" role="status">{children}</div>;
}

export function LoadingSkeleton({ label, grid = false, cards = false, className }: { label: string; grid?: boolean; cards?: boolean; className?: string }) {
  return (
    <div className={`sd2-loading-skeleton${grid ? ' sd2-loading-grid' : ''}${cards ? ' sd2-loading-cards' : ''}${className ? ` ${className}` : ''}`} role="status" aria-label={label}>
      {[0, 1, 2].map(index => (
        <div key={index} className="sd2-loading-row sd2-loading-surface" data-busy="true" aria-hidden="true">
          <div className="sd2-loading-thumb" />
          <div className="sd2-loading-lines"><div className="sd2-loading-line" /><div className="sd2-loading-line" /><div className="sd2-loading-line" /></div>
        </div>
      ))}
    </div>
  );
}
