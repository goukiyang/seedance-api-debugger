'use client';

import React from 'react';

interface Props {
  label: string;
  active?: boolean;
  dropdown?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}

export function ParamChip({ label, active = false, dropdown = false, onClick, disabled = false, title }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'composer-chip',
        active ? 'composer-chip-active' : '',
        disabled ? 'composer-chip-disabled' : '',
      ].filter(Boolean).join(' ')}
    >
      {label}
      {dropdown && <span className="composer-chip-arrow">▼</span>}
    </button>
  );
}
