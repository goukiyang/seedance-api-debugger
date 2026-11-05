'use client';

import { ArrowLeftRight, Check, Film, ImagePlus, Images } from 'lucide-react';
import { Stage } from './stageshow/stage';
import { Window } from './stageshow/window';
import type { Act } from './stageshow/act';
import styles from './demo.module.css';

export type ExperienceDemoKind = 'reference' | 'compare';
type SceneState = { picked: boolean; applied: boolean };
const initial = { picked: false, applied: false };
const poster = { picked: true, applied: true };

async function playScene(act: Act<SceneState>) {
  await act.wait(750);
  await act.move('choice');
  await act.click();
  await act.set({ picked: true });
  act.mark('selected');
  await act.wait(900);
  await act.move('apply');
  await act.click();
  await act.set({ applied: true });
  act.mark('result');
  await act.wait(1750);
}

export default function DemoScene({ kind }: { kind: ExperienceDemoKind }) {
  const reference = kind === 'reference';
  return <div aria-hidden="true" className={styles.scene}>
    <Stage width={720} height={280} compact={{ below: 680, width: 358, height: 368 }}
      initial={initial} poster={poster} script={playScene} play="once" theme="dark"
      accent="#74cdbf" cursor={{ at: { wide: { x: 114, y: 92 }, compact: { x: 42, y: 112 } }, ripple: true }}>
      {(state, _rect, layout) => (
        <div className={`${styles.frame} ${layout === 'compact' ? styles.compact : ''}`}>
          <Window title={reference ? '创作工作台 · 添加参考' : '作品详情 · 成品对比'}>
            <div className={styles.workflow}>
              <div className={styles.source}>
                <span className={styles.caption}>{reference ? '素材库' : '同组作品'}</span>
                <div className={styles.choice} data-target="choice" data-picked={state.picked}>
                  <span className={styles.tile}><Images size={19} /></span>
                  <strong>{reference ? '街巷夜景' : '夜景 · 第二版'}</strong>
                  {state.picked && <Check size={15} />}
                </div>
                <div className={styles.confirm} data-target="apply" data-active={state.picked}>
                  {reference ? <ImagePlus size={15} /> : <ArrowLeftRight size={15} />}
                  {reference ? '加入工作区' : '进入比较'}
                </div>
              </div>
              <div className={styles.destination} data-applied={state.applied}>
                <span className={styles.caption}>{reference ? '本次参考区' : '成品对比'}</span>
                {reference ? <div className={styles.result}>
                  <span className={styles.tile}>{state.applied ? <Images size={22} /> : <ImagePlus size={22} />}</span>
                  <strong>{state.applied ? '街巷夜景' : '等待添加素材'}</strong>
                </div> : <div className={styles.result}>
                  <span className={styles.tile}><Film size={20} /></span>
                  <span className={styles.tile} data-arrived={state.applied}>{state.applied ? <Film size={20} /> : <Images size={20} />}</span>
                  <strong>{state.applied ? '第一版 · 第二版' : '已打开第一版'}</strong>
                </div>}
                <span className={styles.receipt}>{state.applied ? reference ? '已加入参考区' : '两个版本已并排' : '等待确认'}</span>
              </div>
            </div>
          </Window>
        </div>
      )}
    </Stage>
  </div>;
}
