'use client';

interface Props {
  onClick: () => void;
  disabled?: boolean;
}

export function AddReferenceCard({ onClick, disabled = false }: Props) {
  return (
    <button
      type="button"
      className="ref-add-card"
      onClick={onClick}
      disabled={disabled}
      title="添加参考素材"
    >
      <span className="ref-add-icon">+</span>
      <span className="ref-add-label">参考</span>
    </button>
  );
}
