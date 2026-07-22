'use client';

type UploadProgressIndicatorProps = {
  label: string;
  detail?: string;
  percent?: number;
  variant?: 'dark' | 'light';
  className?: string;
};

function formatPercent(percent: number | undefined) {
  if (percent == null || !Number.isFinite(percent)) return null;
  return `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
}

export function UploadProgressIndicator({
  label,
  detail,
  percent,
  variant = 'dark',
  className = '',
}: UploadProgressIndicatorProps) {
  const percentText = formatPercent(percent);
  const classNames = ['upload-progress-indicator', `upload-progress-indicator-${variant}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classNames}
      role={percentText ? 'progressbar' : 'status'}
      aria-live="polite"
      {...(percentText
        ? {
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': Math.max(0, Math.min(100, Math.round(percent || 0))),
        }
        : {})}
    >
      <div className="upload-progress-indicator-head">
        <span>{label}</span>
        {percentText ? <strong>{percentText}</strong> : <em>处理中</em>}
      </div>
      {percentText ? (
        <div className="upload-progress-indicator-track">
          <span style={{ width: percentText }} />
        </div>
      ) : (
        <div className="upload-progress-indicator-stage">
          <span className="loading" />
        </div>
      )}
      {detail && <p>{detail}</p>}
    </div>
  );
}
