'use client';

import { useMemo } from 'react';
import type { MultiviewDraft, MultiviewInfo } from '@/lib/video/multiview-contract';
import type { MultiviewSettingsBinding } from '@/lib/video/multiview-settings-contract';
import { MultiviewSettingsPicker } from './MultiviewSettingsPicker';
import { applyMultiviewFrameSettings, currentMultiviewFrameSettings } from './multiview-frame-settings-client';

type Props = {
  ownerId: string; authorityKey: string; taskId: string; info: MultiviewInfo; draft: MultiviewDraft; disabled: boolean;
  binding?: MultiviewSettingsBinding;
  onApply: (draft: MultiviewDraft, binding: MultiviewSettingsBinding) => void;
  onSavedBinding: (binding: MultiviewSettingsBinding) => void;
  onReset?: () => void;
};

export function MultiviewFrameSettingsPanel(props: Props) {
  const value = useMemo(() => currentMultiviewFrameSettings(props.draft), [props.draft.slots]);
  const target = useMemo(() => ({ taskId: props.taskId, sourceVersion: props.info.sourceVersion }), [props.taskId, props.info.sourceVersion]);
  return <MultiviewSettingsPicker kind="frame" ownerId={props.ownerId} authorityKey={props.authorityKey}
    disabled={props.disabled || !value} value={value} source={target} target={target} binding={props.binding} onReset={props.onReset}
    onSaved={record => props.onSavedBinding({ id: record.id, revision: record.revision })}
    onApply={result => {
      if (result.settings.kind !== 'frame' || !result.slots) throw new Error('选帧方案暂不可确认，当前选帧保留。');
      const next = applyMultiviewFrameSettings(props.draft, props.info, { schema: 1, slots: result.slots });
      if (!next) throw new Error('这份方案不适用于当前视频，原选帧保留。');
      props.onApply(next, { id: result.settings.id, revision: result.settings.revision });
    }} />;
}
