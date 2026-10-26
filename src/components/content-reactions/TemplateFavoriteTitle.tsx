'use client';

import type { ReactNode } from 'react';
import type { ContentKey, ReactionAction, ReactionState } from '@/lib/content-reactions/types';
import ContentReactions from './ContentReactions';
import styles from './reactions.module.css';

export default function TemplateFavoriteTitle({ children, contentKey, initialState, onChange, className = '' }: {
  children: ReactNode;
  contentKey?: ContentKey;
  initialState?: ReactionState;
  onChange?: (state: ReactionState, action: ReactionAction, active: boolean, previous?: ReactionState) => void;
  className?: string;
}) {
  return <div className={`${styles.favoriteTitleRow} ${className}`}>
    {children}
    {contentKey && <ContentReactions contentKey={contentKey} initialState={initialState} onChange={onChange} favoriteOnly />}
  </div>;
}
