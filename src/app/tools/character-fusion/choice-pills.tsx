'use client';
import { useId } from 'react';
import styles from './studio.module.css';

export default function ChoicePills({ label, options, values, multi, onSelect, disabled = false }: {
  label: string; options: { label: string }[]; values: string[]; multi: boolean; onSelect: (value: string) => void; disabled?: boolean;
}) {
  const name = useId();
  return <div className={styles.pills} role={multi ? 'group' : 'radiogroup'} aria-label={`${label}，${multi ? '可多选' : '单选'}`}>
    {options.map(option => <label key={option.label} className={styles.choicePill} data-checked={values.includes(option.label)}>
      <input type={multi ? 'checkbox' : 'radio'} name={name} checked={values.includes(option.label)} disabled={disabled} onChange={() => onSelect(option.label)} />
      <span>{option.label}</span>
    </label>)}
  </div>;
}
