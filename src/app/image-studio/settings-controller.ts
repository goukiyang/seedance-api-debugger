import { defaultStudioTemplateDefaults, parseStudioTemplateDefaults, type StudioTemplateDefaults } from '@/lib/image-studio/template-defaults';
import { IMAGE_STUDIO_MODELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import type { ImageGenerationChannelsDto } from '@/lib/integrations/image-generation-channel';

export type SettingsValue = {
  context?: string;
  revision: number;
  contextConfigured?: boolean;
  taskSettingsProtocol?: 'task-settings-v2' | null;
  model?: ImageStudioModel;
  templateDefaults: StudioTemplateDefaults;
  providerReady: boolean;
  modelReady?: Record<string, boolean>;
  modelFourToOne?: Record<string, boolean>;
  imageChannels?: ImageGenerationChannelsDto;
  billingReadiness?: { models: Record<string, { ready: boolean }> };
  prices: Record<string, number | null>;
};

export type SettingsDraft = { context: string; prices: SettingsValue['prices']; templateDefaults: StudioTemplateDefaults };
export type SettingsWrite = { revision: number; prices: SettingsValue['prices']; templateDefaults: StudioTemplateDefaults; context?: string; confirmContextClear?: boolean };
type SettingsResponse = Omit<SettingsValue, 'templateDefaults'> & { templateDefaults?: unknown };
export type SettingsConflict = { field: string; saved: string | number | boolean | null; draft: string | number | boolean | null };
type SettingsState = {
  settings: SettingsValue | null;
  draft: SettingsDraft | null;
  loading: boolean;
  saving: boolean;
  error: string;
  status: string;
  conflicts: SettingsConflict[];
};
type Transport = { read: (signal?: AbortSignal) => Promise<SettingsResponse>; write: (value: SettingsWrite) => Promise<SettingsResponse>;
  onSaved?: (revision: number) => void };

function settingsDraft(settings: SettingsValue): SettingsDraft {
  return { context: settings.context ?? '', prices: { ...settings.prices }, templateDefaults: { ...settings.templateDefaults } };
}

// Merge against the last confirmed value, not against a replacement revision.
// A conflicting field stays blocked until its owner explicitly resolves it.
function mergeSettingsDraft(previous: SettingsValue, draft: SettingsDraft, next: SettingsValue, unresolved: SettingsConflict[]) {
  const result = settingsDraft(next);
  const conflicts: SettingsConflict[] = [];
  const field = (name: string, before: SettingsConflict['saved'], mine: SettingsConflict['draft'], saved: SettingsConflict['saved']) => {
    if (mine === saved) return saved;
    if (mine === before && !unresolved.some(item => item.field === name)) return saved;
    if (before !== saved || unresolved.some(item => item.field === name)) conflicts.push({ field: name, saved, draft: mine });
    return mine;
  };
  result.context = field('context', previous.context ?? '', draft.context, next.context ?? '') as string;
  for (const key of Array.from(new Set([...Object.keys(previous.prices), ...Object.keys(draft.prices), ...Object.keys(next.prices)]))) {
    result.prices[key] = field(`prices.${key}`, previous.prices[key] ?? null, draft.prices[key] ?? null, next.prices[key] ?? null) as number | null;
  }
  for (const key of Object.keys(next.templateDefaults) as Array<keyof StudioTemplateDefaults>) {
    Object.assign(result.templateDefaults, { [key]: field(`templateDefaults.${key}`, previous.templateDefaults[key], draft.templateDefaults[key], next.templateDefaults[key]) });
  }
  return { draft: result, conflicts };
}

function samePrices(a: SettingsValue['prices'], b: SettingsValue['prices']) {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
}

function sameTemplateDefaults(a: StudioTemplateDefaults, b: StudioTemplateDefaults) {
  return Object.keys(defaultStudioTemplateDefaults()).every(key => a[key as keyof StudioTemplateDefaults] === b[key as keyof StudioTemplateDefaults]);
}

export function studioSettingsDirty(state: SettingsState) {
  return Boolean(state.settings && state.draft && (
    state.draft.context !== (state.settings.context ?? '') || !samePrices(state.draft.prices, state.settings.prices)
      || !sameTemplateDefaults(state.draft.templateDefaults, state.settings.templateDefaults)
  ));
}

// One controller belongs to the page, never to whichever template happens to be first.
export function createStudioSettingsController(isAdmin: boolean, transport: Transport) {
  let state: SettingsState = { settings: null, draft: null, loading: false, saving: false, error: '', status: '', conflicts: [] };
  let readSequence = 0;
  let accountEpoch = 0;
  let notifiedRevision = -1;
  let active = true;
  let readAbort: AbortController | null = null;
  let pendingRead: Promise<SettingsValue | null> | null = null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<SettingsState>) => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  const edit = (draft: SettingsDraft) => {
    const conflicts = state.conflicts.map(conflict => {
      const value = conflict.field === 'context' ? draft.context : conflict.field.startsWith('prices.')
        ? draft.prices[conflict.field.slice(7)] ?? null : draft.templateDefaults[conflict.field.slice(17) as keyof StudioTemplateDefaults];
      return { ...conflict, draft: value };
    }).filter(conflict => conflict.draft !== conflict.saved);
    update({ draft, conflicts, status: conflicts.length ? '部分设置同时被修改，请核对差异' : '设置未保存' });
  };
  function validate(value: SettingsResponse): SettingsValue {
    if (!value || !Number.isInteger(value.revision) || !value.prices || (isAdmin && typeof value.context !== 'string')) {
      throw new Error('通用设置未完整读取，请重试');
    }
    return { ...value, templateDefaults: value.templateDefaults === undefined
      ? defaultStudioTemplateDefaults(value.model && IMAGE_STUDIO_MODELS.includes(value.model) ? value.model : undefined)
      : parseStudioTemplateDefaults(value.templateDefaults) };
  }
  const cancelRead = () => { ++readSequence; readAbort?.abort(); readAbort = null; pendingRead = null; if (state.loading) update({ loading: false }); };
  function load(discardDraft = false): Promise<SettingsValue | null> {
    if (!active || state.saving) return Promise.resolve(null);
    if (pendingRead && !discardDraft) return pendingRead;
    cancelRead();
    const sequence = readSequence;
    const epoch = accountEpoch;
    readAbort = new AbortController();
    const signal = readAbort.signal;
    update({ loading: !state.settings, error: '', status: state.settings ? state.status : '正在读取通用设置' });
    pendingRead = (async () => {
      try {
        const settings = validate(await transport.read(signal));
        if (!active || epoch !== accountEpoch || sequence !== readSequence) return null;
        if (state.settings && settings.revision < state.settings.revision) throw new Error('读取到旧设置，当前输入已保留，请重试');
        const merged = state.settings && state.draft && !discardDraft
          ? mergeSettingsDraft(state.settings, state.draft, settings, state.conflicts)
          : { draft: settingsDraft(settings), conflicts: [] };
        update({ settings, ...merged, loading: false, error: '' });
        update({ status: merged.conflicts.length ? '部分设置同时被修改，请核对差异' : studioSettingsDirty(state) ? '设置未保存' : '已保存' });
        return settings;
      } catch (error) {
        if (active && epoch === accountEpoch && sequence === readSequence && !signal.aborted) {
          update({ loading: false, error: error instanceof Error ? error.message : '读取失败，请重试', status: '读取失败，当前输入保留' });
        }
        return null;
      } finally { if (sequence === readSequence) { pendingRead = null; readAbort = null; } }
    })();
    return pendingRead;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancelRead,
    activate() { active = true; },
    dispose() { active = false; ++accountEpoch; cancelRead(); },
    load,
    invalidate(revision: number) {
      notifiedRevision = Math.max(notifiedRevision, revision);
      if (state.saving) return;
      cancelRead();
      void load();
    },
    refreshAvailability: () => load(),
    resolveConflict(field: string, choice: 'saved' | 'draft') {
      if (!active || state.saving || !state.draft) return;
      const conflict = state.conflicts.find(item => item.field === field);
      if (!conflict) return;
      const draft = { ...state.draft, prices: { ...state.draft.prices }, templateDefaults: { ...state.draft.templateDefaults } };
      if (choice === 'saved') {
        if (field === 'context') draft.context = conflict.saved as string;
        else if (field.startsWith('prices.')) draft.prices[field.slice(7)] = conflict.saved as number | null;
        else if (field.startsWith('templateDefaults.')) Object.assign(draft.templateDefaults, { [field.slice(17)]: conflict.saved });
      }
      update({ draft, conflicts: state.conflicts.filter(item => item.field !== field), error: '', status: '已核对差异，修改尚未保存' });
    },
    editContext(context: string) {
      if (!isAdmin || !state.draft || state.loading) return;
      edit({ ...state.draft, context });
    },
    editPrice(model: string, price: number | null) {
      if (!isAdmin || !state.draft || state.loading) return;
      edit({ ...state.draft, prices: { ...state.draft.prices, [model]: price } });
    },
    editTemplateDefaults(patch: Partial<StudioTemplateDefaults>) {
      if (!isAdmin || !state.draft || state.loading) return;
      edit({ ...state.draft, templateDefaults: { ...state.draft.templateDefaults, ...patch } });
    },
    acceptCommitted(saved: SettingsResponse, submittedDraft: SettingsDraft) {
      if (!active) return false;
      const savedValue = validate({ ...state.settings, ...saved });
      if (!state.settings || savedValue.revision < state.settings.revision) return false;
      cancelRead();
      const merged = state.draft ? mergeSettingsDraft({ ...state.settings, ...submittedDraft }, state.draft, savedValue, [])
        : { draft: settingsDraft(savedValue), conflicts: [] };
      update({ settings: savedValue, ...merged, error: '' });
      transport.onSaved?.(savedValue.revision);
      update({ status: studioSettingsDirty(state) ? '默认值已保存；有新的修改尚未保存' : '默认值已保存' });
      return !studioSettingsDirty(state);
    },
    async save() {
      if (!active || !isAdmin || !state.settings || !state.draft || state.loading || state.saving || state.conflicts.length || !studioSettingsDirty(state)) return false;
      let templateDefaults: StudioTemplateDefaults;
      try {
        templateDefaults = parseStudioTemplateDefaults(state.draft.templateDefaults);
      } catch (error) {
        update({ status: '未保存', error: error instanceof Error ? error.message : '统一默认设置无效，请检查后重试' });
        return false;
      }
      cancelRead();
      const epoch = accountEpoch;
      const contextChanged = state.draft.context !== state.settings.context;
      const payload: SettingsWrite = { revision: state.settings.revision, prices: { ...state.draft.prices },
        templateDefaults,
        ...(contextChanged ? { context: state.draft.context, confirmContextClear: state.draft.context.trim().length === 0 } : {}) };
      const baseline = state.settings;
      const submittedDraft = state.draft;
      update({ saving: true, error: '', status: '正在保存' });
      try {
        const saved = await transport.write(payload);
        if (!active || epoch !== accountEpoch) return false;
        const savedValue = validate(saved);
        if (savedValue.revision <= baseline.revision) throw new Error('保存结果尚未确认，当前输入已保留，请重新读取核对');
        const value = { ...baseline, ...savedValue };
        value.contextConfigured = Boolean(value.context?.trim());
        const merged = mergeSettingsDraft({ ...baseline, ...submittedDraft }, state.draft!, value, []);
        update({ settings: value, saving: false, ...merged });
        update({ status: studioSettingsDirty(state) ? '有新的修改尚未保存' : '已保存' });
        transport.onSaved?.(value.revision);
        return !studioSettingsDirty(state);
      } catch (error) {
        if (!active || epoch !== accountEpoch) return false;
        update({ saving: false, status: '未保存', error: error instanceof Error ? error.message : '保存失败，请重试' });
        return false;
      } finally {
        if (active && epoch === accountEpoch && notifiedRevision > (state.settings?.revision ?? -1)) await load();
      }
    },
  };
}

export type StudioSettingsController = ReturnType<typeof createStudioSettingsController>;
