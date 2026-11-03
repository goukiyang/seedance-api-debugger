'use client';

import dynamic from 'next/dynamic';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
import { Smile } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from './WorkLearning.module.css';

const EmojiPicker = dynamic(async () => {
  const [{ default: Picker }, { default: data }] = await Promise.all([import('emoji-picker-react'), import('emoji-picker-react/data/emojis-zh')]);
  return function ChineseEmojiPicker(props: import('emoji-picker-react').PickerProps) {
    return <Picker {...props} emojiData={data} labels={{ searchPlaceholder: '搜索表情', searchLabel: '搜索表情', searchClear: '清空搜索', searchResultsNone: '没有找到表情', searchResultsOne: '找到 1 个表情', searchResultsMany: '找到 %n 个表情', categoryNavigation: '表情分类', loading: '正在加载表情…', loadingError: '表情未能加载' }} />;
  };
}, { ssr: false, loading: () => <p role="status">正在打开表情…</p> });

export function WorkEmojiPicker({ disabled, onSelect }: { disabled: boolean; onSelect: (emoji: string) => void }) {
  const [open, setOpen] = useState(false), id = useId();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useDialogDismiss({ open, dialogRef: panel, branchRefs: [trigger], modal: false, onDismiss: () => setOpen(false) });
  return <Popper.Root><Popper.Anchor asChild><button ref={trigger} type="button" aria-label="插入表情" title="表情" aria-controls={open ? id : undefined}
    aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(value => !value)}><Smile size={18} /></button></Popper.Anchor>
    {open && createPortal(<Popper.Content ref={panel} id={id} role="dialog" aria-label="选择表情" className={styles.emojiPanel} side="top" align="start" sideOffset={8} collisionPadding={12}>
        <EmojiPicker emojiStyle="native" colorScheme="auto" width="100%" height={350} previewConfig={{ showPreview: false }}
          suggestedEmojis={['👍', '❤️', '👏', '😀', '🎉', '🤔']} onEmojiClick={data => { onSelect(data.emoji); setOpen(false); }} />
    </Popper.Content>, trigger.current?.closest('dialog') || document.body)}
  </Popper.Root>;
}
