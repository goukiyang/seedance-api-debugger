'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
import { Check, Grid2X2, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { RelativeTime } from '@/components/RelativeTime';
import { characterLabMediaUrl, sameLabReference, type CharacterLabFace, type CharacterLabPlan } from '@/lib/character-lab/types';
import { CharacterLabImage } from './images';
import styles from './studio.module.css';

export function FrontVersionPicker({ groups, current, adopted, disabled, onBrowse }: {
  groups: Array<{ plan: CharacterLabPlan; label: string }>;
  current?: CharacterLabFace | null;
  adopted?: CharacterLabFace | null;
  disabled: boolean;
  onBrowse: (face: CharacterLabFace) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDivElement>(null);
  const currentButton = useRef<HTMLButtonElement>(null);
  const open = expanded && !disabled;
  useDialogDismiss({ open, dialogRef: dialog, branchRefs: [trigger], initialFocusRef: currentButton,
    modal: false, onDismiss: () => setExpanded(false) });
  useEffect(() => {
    if (open) currentButton.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [open]);

  return <Popper.Root>
    <Popper.Anchor asChild>
      <button ref={trigger} type="button" className={styles.avatarTrigger} disabled={disabled}
        aria-label="选择正脸版本，按候选批次查看" aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? id : undefined} title="选择正脸版本" onClick={() => setExpanded(value => !value)}>
        {current ? <CharacterLabImage src={characterLabMediaUrl(current.planId, current.cell)} alt="当前浏览的正脸版本" /> : <Grid2X2 size={22} />}
        <span className={styles.avatarTriggerMark}><Grid2X2 size={12} aria-hidden="true" /></span>
      </button>
    </Popper.Anchor>
    {open && createPortal(<Popper.Content side="bottom" align="end" sideOffset={8} collisionPadding={12}
      avoidCollisions sticky="always" hideWhenDetached className={styles.avatarLayer}>
      <div ref={dialog} id={id} role="dialog" aria-labelledby={id + '-title'} tabIndex={-1}>
        <header className={styles.avatarHeader}><strong id={id + '-title'}>选择正脸版本</strong>
          <button type="button" className={styles.iconButton} aria-label="关闭正脸版本" onClick={() => setExpanded(false)}><X size={17} /></button>
        </header>
        <div className={styles.avatarBatches}>
          {groups.map(({ plan, label }) => <section key={plan.id} className={styles.avatarBatch} aria-label={label}>
            <header><strong>{label}</strong><span>{plan.count} 张 · <RelativeTime value={plan.createdAt} /></span></header>
            <div className={styles.avatarGrid} data-count={plan.count}>
              {Array.from({ length: plan.count }, (_, cell) => {
                const face = { planId: plan.id, cell }, viewed = sameLabReference(current, face), selected = sameLabReference(adopted, face);
                return <button key={cell} ref={viewed ? currentButton : undefined} type="button" className={styles.avatarChoice}
                  data-viewed={viewed || undefined} data-adopted={selected || undefined} aria-pressed={viewed}
                  aria-label={`${label}，第 ${cell + 1} 格${selected ? '，已选用' : ''}`}
                  onClick={() => { onBrowse(face); setExpanded(false); }}>
                  <CharacterLabImage src={characterLabMediaUrl(plan.id, cell)} alt={`${label}第 ${cell + 1} 格`} />
                  <span className={styles.avatarCellLabel}>{cell + 1}</span>
                  {selected && <span className={styles.avatarAdopted}><Check size={13} />已选用</span>}
                </button>;
              })}
            </div>
          </section>)}
        </div>
      </div>
    </Popper.Content>, trigger.current?.closest('main') || document.body)}
  </Popper.Root>;
}
