'use client';

import React from 'react';

interface Props {
  label: string;
  active?: boolean;
  dropdown?: boolean;
  onClick?: () => void;
}

export function ParamChip({ label, active = false, dropdown = false, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'composer-chip',
        active ? 'composer-chip-active' : '',
      ].filter(Boolean).join(' ')}
    >
      {label}
      {dropdown && <span className="composer-chip-arrow">▼</span>}
    </button>
  );
}
