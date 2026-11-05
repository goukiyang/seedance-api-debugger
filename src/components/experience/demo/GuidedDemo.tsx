'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { scenarios, type ExperienceDemoKind } from './scenarios';
import styles from './demo.module.css';

const DemoScene = dynamic(() => import('./DemoScene'), { ssr: false });


export function GuidedDemo({ kind }: { kind: ExperienceDemoKind }) {
  const [open, setOpen] = useState(false);
  const [replay, setReplay] = useState(0);
  const scenario = scenarios[kind];
  return <details className={styles.demo} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{scenario.title}</summary>
    {open && <div className={styles.body}>
      <DemoScene key={replay} kind={kind} />
      <ol>{scenario.steps.map(step => <li key={step}>{step}</li>)}</ol>
      <div><button type="button" className="btn btn-secondary" onClick={() => setReplay(value => value + 1)}>重播演示</button></div>
    </div>}
  </details>;
}
