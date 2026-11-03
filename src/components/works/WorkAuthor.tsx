'use client';

import { useEffect, useState } from 'react';
import styles from './Works.module.css';

export function WorkAuthor({ author, onClick }: { author: { name: string; avatarUrl?: string | null }; onClick?: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [author.avatarUrl]);
  const identity = <><span className={styles.authorAvatar} aria-hidden="true">{author.avatarUrl && !failed
    ? <img src={author.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    : author.name.slice(0, 1)}</span><span className={styles.authorName}>{author.name}</span></>;
  return onClick ? <button type="button" className={styles.authorIdentity} onClick={onClick} title={author.name}>{identity}</button>
    : <span className={styles.authorIdentity}>{identity}</span>;
}
