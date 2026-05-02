'use client';

interface Props {
  onClick: () => void;
  onSecondaryClick?: () => void;
  secondaryLabel?: string;
  disabled?: boolean;
}

export function AddReferenceCard({
  onClick,
  onSecondaryClick,
  secondaryLabel = '从资产库选择',
  disabled = false,
}: Props) {
  return (
    <div className="ref-add-card-wrap">
      <button
        type="button"
        className="ref-add-card"
        onClick={onClick}
        disabled={disabled}
        title="添加参考图"
      >
        <span className="ref-add-icon">+</span>
        <span className="ref-add-label">上传</span>
      </button>
      {onSecondaryClick && (
        <button
          type="button"
          className="ref-add-card-secondary"
          onClick={onSecondaryClick}
          disabled={disabled}
          title={secondaryLabel}
        >
          <span className="ref-add-icon">⬡</span>
          <span className="ref-add-label">{secondaryLabel}</span>
        </button>
      )}
    </div>
  );
}
