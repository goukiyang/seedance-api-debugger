'use client';

import { ArrowLeftRight, Check, Film, ImagePlus, Images } from 'lucide-react';
import { Stage } from './stageshow/stage';
import { Window } from './stageshow/window';
import type { Act } from './stageshow/act';
import { scenarios, type ExperienceDemoKind } from './scenarios';
import styles from './demo.module.css';

type SceneState = { step: number };
const initial = { step: 0 };

export default function DemoScene({ kind }: { kind: ExperienceDemoKind }) {
  const scene = scenarios[kind];
  async function playScene(act: Act<SceneState>) {
    await act.wait(600);
    await act.move('choice');
    await act.click();
    await act.set({ step: 1 });
    act.mark('selected');
    await act.wait(750);
    await act.move('apply');
    await act.click();
    await act.set({ step: 2 });
    act.mark('result');
    if (scene.follow) {
      await act.wait(1000);
      await act.move('follow');
      await act.click();
      await act.set({ step: 3 });
      act.mark('continued');
    }
    await act.wait(1750);
  }
  return <div aria-hidden="true" className={styles.scene}>
    <Stage width={720} height={300} compact={{ below: 680, width: 358, height: 410 }}
      initial={initial} poster={{ step: scene.follow ? 3 : 2 }} script={playScene} play="once" theme="dark"
      accent="#74cdbf" cursor={{ at: { wide: { x: 114, y: 92 }, compact: { x: 42, y: 112 } }, ripple: true }}>
      {(state, _rect, layout) => {
        const applied = state.step >= 2;
        const finished = state.step === 3 && scene.follow;
        return <div className={`${styles.frame} ${layout === 'compact' ? styles.compact : ''}`}>
          <Window title={scene.window}>
            <div className={styles.workflow}>
              <div className={styles.source}>
                <span className={styles.caption}>{scene.source}</span>
                <div className={styles.choice} data-target="choice" data-picked={state.step >= 1}>
                  <span className={styles.tile}><Images size={19} /></span>
                  <strong>{scene.choice}</strong>
                  {state.step >= 1 && <Check size={15} />}
                </div>
                <div className={styles.confirm} data-target="apply" data-active={state.step >= 1}>
                  {kind === 'compare' ? <ArrowLeftRight size={15} /> : <ImagePlus size={15} />}
                  {scene.apply}
                </div>
              </div>
              <div className={styles.destination} data-applied={applied}>
                <span className={styles.caption}>{scene.destination}</span>
                <div className={`${styles.result} ${kind === 'compare' ? styles.compareResult : ''}`}>
                  {kind === 'compare' ? <span className={styles.compareTiles} data-swapped={Boolean(finished)}>
                    <span className={styles.tile}><Film size={18} /><small>第一版</small></span>
                    <span className={styles.tile} data-arrived={applied}><Film size={18} /><small>第二版</small></span>
                  </span> : <span className={styles.tile}>{kind === 'frames' ? <Film size={20} /> : <Images size={22} />}</span>}
                  <strong>{finished ? scene.follow!.result : applied ? scene.result : '等待本次操作'}</strong>
                </div>
                {scene.follow && <div className={styles.confirm} data-target="follow" data-active={applied} data-visible={applied}>
                  {scene.follow.label}
                </div>}
                <span className={styles.receipt}>{finished ? scene.follow!.receipt : applied ? scene.receipt : '等待确认'}</span>
              </div>
            </div>
          </Window>
        </div>;
      }}
    </Stage>
  </div>;
}
