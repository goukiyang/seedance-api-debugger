'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Heart } from 'lucide-react';
import '../../../public/tools/ultimate-canvas/like-button.css';

// Bencho Like, MIT (c) 2026 Lorenzo Cabra. Notice shipped beside shared CSS.
const colors = ['#f48ea7', '#cc8ef5', '#8ce8c3', '#91d2fa', '#f5a524', '#e5484d', '#9fc7fa'];
const format = (value: number) => value.toLocaleString('en-US');

function Roll({ value, animate }: { value: number; animate: boolean }) {
  const [snapshot, setSnapshot] = useState({ value, previous: value, revision: 0 });
  if (snapshot.value !== value) setSnapshot({ value, previous: snapshot.value, revision: snapshot.revision + 1 });
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(snapshot.revision), 1000);
    return () => clearTimeout(timer);
  }, [snapshot.revision]);
  const chars = format(value).split('');
  const previous = format(snapshot.previous).split('').reverse();
  const up = value > snapshot.previous;
  return <span className="lk-count" aria-hidden="true">{chars.map((char, index) => {
    const place = chars.length - 1 - index;
    if (char === ',') return <span className="lk-comma" key={`c${place}`}>,</span>;
    const old = previous[place];
    const changed = animate && settled !== snapshot.revision && char !== old;
    return <span className="lk-wheel" key={`p${place}`} style={{ '--delay': `${place * 40}ms`, '--from': up ? '100%' : '-100%', '--to': up ? '-100%' : '100%' } as CSSProperties}>
      {changed && old && old !== ',' && <span key={`out-${snapshot.revision}`} className="lk-digit lk-digit-out">{old}</span>}
      <span key={changed ? `in-${snapshot.revision}` : char} className={`lk-digit${changed ? ' lk-digit-in' : ''}`}>{char}</span>
    </span>;
  })}</span>;
}

export default function LikeButton({ active, count, showCount, animateCount, disabled, bloom, onClick }: {
  active: boolean; count?: number | null; showCount: boolean; animateCount: boolean; disabled: boolean; bloom: number; onClick: () => void;
}) {
  const label = active ? '取消喜欢' : '喜欢';
  return <button className="sd2-like" type="button" data-reaction-action="like" data-bloom={active && bloom || undefined}
    title={count == null ? label : `${label} · 公开喜欢人数 ${format(count)}`} aria-label={count == null ? label : `${label}，公开喜欢人数 ${format(count)}`} aria-pressed={active} disabled={disabled} onClick={onClick}>
    <span className="lk-heart"><span key={active && bloom ? bloom : 'still'} className="lk-glyph"><Heart size={19} strokeWidth={2.3} fill={active ? 'currentColor' : 'none'} /></span>
      {active && bloom > 0 && <span className="lk-burst" key={bloom} aria-hidden="true"><span className="lk-bloom" />{colors.map((color, index) => <span key={index} className="lk-spoke" style={{ '--a': `${index * (360 / 7) - 90}deg` } as CSSProperties}><i style={{ '--c': color } as CSSProperties} /><i style={{ '--c': colors[(index + 3) % colors.length] } as CSSProperties} /></span>)}</span>}
    </span>
    {showCount && (count != null ? <Roll value={count} animate={animateCount} /> : <span className="lk-count" aria-hidden="true">-</span>)}
  </button>;
}
