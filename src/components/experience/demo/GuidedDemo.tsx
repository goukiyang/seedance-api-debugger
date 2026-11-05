'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { ExperienceDemoKind } from './DemoScene';
import styles from './demo.module.css';

const DemoScene = dynamic(() => import('./DemoScene'), { ssr: false });
const scenarios = {
  reference: { title: '怎么把素材加入参考区', steps: ['打开素材库，选中需要的素材。', '点击「加入工作区」，再从回执打开生成工作区。', '在参考区查看刚加入的素材。'] },
  compare: { title: '怎么并排比较两个版本', steps: ['在作品详情展开「比较作品」。', '选择一个同组作品，点击「进入比较」。', '并排查看两件作品，必要时交换左右。'] },
} satisfies Record<ExperienceDemoKind, { title: string; steps: string[] }>;

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
