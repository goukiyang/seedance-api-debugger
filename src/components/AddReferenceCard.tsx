'use client';

interface Props {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}

export function AddReferenceCard({ onClick, disabled = false, label = '参考' }: Props) {
  return (
    <button
      type="button"
      className="ref-add-card"
      onClick={onClick}
      disabled={disabled}
      title="添加参考素材"
    >
      <span className="ref-add-icon">+</span>
      <span className="ref-add-label">{label}</span>
    </button>
  );
}
