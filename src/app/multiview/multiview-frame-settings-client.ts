import type { MultiviewDraft, MultiviewInfo } from '@/lib/video/multiview-contract';
import { parseMultiviewFrameSettingsInput, type MultiviewFrameSettingsInput } from '@/lib/video/multiview-settings-contract';

/** Settings contain frame choices only, never media/work identities or output layout. */
export function currentMultiviewFrameSettings(draft: MultiviewDraft): MultiviewFrameSettingsInput | null {
  return parseMultiviewFrameSettingsInput({ schema: 1, slots: draft.slots.map(({ frame, name }) => ({ frame, name })) });
}

/** The API has already checked timing compatibility; still reject malformed/late response data. */
export function applyMultiviewFrameSettings(draft: MultiviewDraft, info: MultiviewInfo, input: unknown,
  createId: () => string = () => crypto.randomUUID()): MultiviewDraft | null {
  const value = parseMultiviewFrameSettingsInput(input);
  if (!value || draft.sourceVersion !== info.sourceVersion || value.slots.some(item => item.frame >= info.timestamps.length)) return null;
  const ids = new Set(draft.reserve.map(item => item.id));
  const slots = value.slots.map((item, index) => {
    const id = draft.slots[index]?.id || createId();
    return { id, frame: item.frame, name: item.name, manual: true };
  });
  for (const item of slots) {
    if (!/^[a-z0-9-]{1,80}$/i.test(item.id) || ids.has(item.id)) return null;
    ids.add(item.id);
  }
  // The caller uses the existing undo boundary. Existing hidden choices and layout stay intact.
  return { ...draft, slots, reserve: draft.reserve, layout: draft.layout, editing: null, editorFrame: undefined, restoreOrder: undefined };
}
