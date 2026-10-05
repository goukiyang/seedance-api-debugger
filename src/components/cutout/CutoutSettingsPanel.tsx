'use client';

import { useId } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ModelOption, CutoutSettings } from '@/lib/cutout/types';
import { CUTOUT_PRESETS, type CutoutPresetKey } from '@/lib/cutout/settings';
import styles from '@/app/cutout/cutout.module.css';

type Props = {
  settings: CutoutSettings;
  modelOptions: ModelOption[];
  advancedOpen: boolean;
  disabled?: boolean;
  onChange: (settings: CutoutSettings) => void;
  onAdvancedOpenChange: (open: boolean) => void;
  onReset: () => void;
};

const MAIN_SLIDERS: Array<{ key: keyof CutoutSettings; label: string; hint: string }> = [
  { key: 'background_removal', label: '背景移除', hint: '调高会更积极地清除背景，也可能吃掉主体边缘。' },
  { key: 'edge_smooth', label: '边缘平滑', hint: '柔化锯齿和生硬的边缘过渡。' },
  { key: 'residue_cleanup', label: '残留清理', hint: '清理主体周围的小块、脏边和噪点。' },
  { key: 'hole_repair', label: '孔洞修复', hint: '修复主体内部或边缘的小破洞。' },
  { key: 'detail_protection', label: '细节保护', hint: '尽量保留眼睛、线条等主体内部细节。' },
  { key: 'shadow_retention', label: '阴影保留', hint: '控制主体周围柔和阴影的保留程度。' },
];

const ADVANCED_NUMBERS: Array<{ key: keyof CutoutSettings; label: string; min: number; max: number; step: number }> = [
  { key: 'foreground_threshold', label: '前景阈值', min: 0, max: 255, step: 1 },
  { key: 'background_threshold', label: '背景阈值', min: 0, max: 255, step: 1 },
  { key: 'erode_size', label: 'Matting 腐蚀', min: 0, max: 32, step: 1 },
  { key: 'mask_expand', label: '遮罩外扩', min: 0, max: 32, step: 1 },
  { key: 'mask_contract', label: '遮罩内缩', min: 0, max: 32, step: 1 },
  { key: 'feather', label: '羽化半径', min: 0, max: 12, step: 0.1 },
  { key: 'alpha_clamp_foreground', label: '主体 Alpha 拉满', min: 0, max: 255, step: 1 },
  { key: 'background_alpha_cutoff', label: '背景 Alpha 清零', min: 0, max: 255, step: 1 },
  { key: 'edge_decontaminate_strength', label: '边缘去污染强度', min: 0, max: 1, step: 0.05 },
  { key: 'edge_band_width', label: '边缘处理宽度', min: 0, max: 32, step: 1 },
];

const ADVANCED_TOGGLES: Array<{ key: keyof CutoutSettings; label: string }> = [
  { key: 'alpha_matting', label: '启用 Alpha matting' },
  { key: 'remove_small_noise', label: '删除小噪点' },
  { key: 'fill_holes', label: '填补主体洞' },
  { key: 'edge_decontaminate', label: '边缘去污染' },
];

const PRESET_KEYS = Object.keys(CUTOUT_PRESETS) as CutoutPresetKey[];

function numericValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export default function CutoutSettingsPanel({
  settings,
  modelOptions,
  advancedOpen,
  disabled = false,
  onChange,
  onAdvancedOpenChange,
  onReset,
}: Props) {
  const advancedId = useId();
  const update = (key: keyof CutoutSettings, value: number | boolean | string | undefined) => {
    onChange({ ...settings, [key]: value, preset: undefined });
  };

  return (
    <section className={styles.settingsPanel} aria-labelledby="cutout-settings-title">
      <div className={styles.sectionHeading}>
        <div>
          <h2 id="cutout-settings-title">抠图参数</h2>
        </div>
        <button className={styles.quietButton} type="button" onClick={onReset} disabled={disabled}>
          <RotateCcw size={15} aria-hidden="true" />
          恢复默认
        </button>
      </div>

      <div className={styles.presetList} role="group" aria-label="参数预设">
        {PRESET_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`${styles.presetButton} ${settings.preset === key ? styles.presetActive : ''}`}
            aria-pressed={settings.preset === key}
            onClick={() => onChange({ ...CUTOUT_PRESETS[key].settings })}
            disabled={disabled}
          >
            {CUTOUT_PRESETS[key].name}
          </button>
        ))}
      </div>

      <label className={styles.controlLabel} htmlFor="cutout-model-select">抠图模型</label>
      <select
        id="cutout-model-select"
        className={styles.selectControl}
        value={settings.model_preference}
        onChange={(event) => update('model_preference', event.target.value)}
        disabled={disabled || modelOptions.length === 0}
      >
        {modelOptions.map((model) => (
          <option key={model.id} value={model.id} disabled={!model.available}>
            {model.label || model.id}{model.available ? '' : `（暂不可用：${model.reason || '服务未就绪'}）`}
          </option>
        ))}
      </select>

      <div className={styles.sliderList}>
        {MAIN_SLIDERS.map((field) => (
          <label className={styles.sliderField} key={field.key} title={field.hint}>
            <span className={styles.sliderTopline}>
              <span>{field.label}</span>
              <output>{Math.round(numericValue(settings[field.key]))}</output>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={numericValue(settings[field.key])}
              onChange={(event) => update(field.key, Number(event.target.value))}
              disabled={disabled}
            />
          </label>
        ))}
      </div>

      <details
        className={styles.advancedSettings}
        open={advancedOpen}
        onToggle={(event) => onAdvancedOpenChange(event.currentTarget.open)}
      >
        <summary aria-controls={advancedId}>高级参数</summary>
        <div id={advancedId} className={styles.advancedBody}>
          <div className={styles.toggleGrid}>
            {ADVANCED_TOGGLES.map((field) => (
              <label className={styles.toggleField} key={field.key}>
                <input
                  type="checkbox"
                  checked={Boolean(settings[field.key])}
                  onChange={(event) => update(field.key, event.target.checked)}
                  disabled={disabled}
                />
                <span>{field.label}</span>
              </label>
            ))}
          </div>
          <div className={styles.advancedSliderList}>
            {ADVANCED_NUMBERS.map((field) => (
              <label className={styles.sliderField} key={field.key}>
                <span className={styles.sliderTopline}>
                  <span>{field.label}</span>
                  <output>{numericValue(settings[field.key]).toFixed(field.step < 1 ? 1 : 0)}</output>
                </span>
                <input
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={numericValue(settings[field.key])}
                  onChange={(event) => update(field.key, Number(event.target.value))}
                  disabled={disabled}
                />
              </label>
            ))}
          </div>
        </div>
      </details>
    </section>
  );
}
