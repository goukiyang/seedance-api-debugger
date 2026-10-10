import { defaultStudioTemplateDefaults, parseStudioTemplateDefaults, type StudioTemplateDefaults } from '@/lib/image-studio/template-defaults';
import { IMAGE_STUDIO_MODELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';

export type SettingsValue = {
  context?: string;
  revision: number;
  contextConfigured?: boolean;
  model?: ImageStudioModel;
  templateDefaults: StudioTemplateDefaults;
  providerReady: boolean;
  modelReady?: Record<string, boolean>;
  modelFourToOne?: Record<string, boolean>;
  billingReadiness?: { models: Record<string, { ready: boolean }> };
  prices: Record<string, number | null>;
};

export type SettingsDraft = { context: string; prices: SettingsValue['prices']; templateDefaults: StudioTemplateDefaults };
export type SettingsWrite = { revision: number; prices: SettingsValue['prices']; templateDefaults: StudioTemplateDefaults; context?: string; confirmContextClear?: boolean };
type SettingsResponse = Omit<SettingsValue, 'templateDefaults'> & { templateDefaults?: unknown };
type SettingsState = {
  settings: SettingsValue | null;
  draft: SettingsDraft | null;
  loading: boolean;
  saving: boolean;
  error: string;
  status: string;
};
type Transport = { read: () => Promise<SettingsResponse>; write: (value: SettingsWrite) => Promise<SettingsResponse> };

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
  let state: SettingsState = { settings: null, draft: null, loading: false, saving: false, error: '', status: '' };
  let readSequence = 0;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<SettingsState>) => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  function validate(value: SettingsResponse): SettingsValue {
    if (!value || !Number.isInteger(value.revision) || !value.prices || (isAdmin && typeof value.context !== 'string')) {
      throw new Error('通用设置未完整读取，请重试');
    }
    return { ...value, templateDefaults: value.templateDefaults === undefined
      ? defaultStudioTemplateDefaults(value.model && IMAGE_STUDIO_MODELS.includes(value.model) ? value.model : undefined)
      : parseStudioTemplateDefaults(value.templateDefaults) };
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancelRead() { ++readSequence; if (state.loading) update({ loading: false }); },
    async load(discardDraft = false) {
      if (state.saving) { update({ status: '正在保存，请稍后重新读取' }); return; }
      if (studioSettingsDirty(state) && !discardDraft) {
        update({ status: '未保存的修改已保留，请保存或重新读取' }); return;
      }
      const sequence = ++readSequence;
      update({ loading: true, error: '', status: '正在读取通用设置' });
      try {
        const value = await transport.read();
        if (sequence !== readSequence) return;
        const settings = validate(value);
        update({ settings, draft: { context: settings.context ?? '', prices: { ...settings.prices }, templateDefaults: { ...settings.templateDefaults } }, loading: false, status: '已保存' });
      } catch (error) {
        if (sequence === readSequence) update({ loading: false, error: error instanceof Error ? error.message : '读取失败，请重试', status: '读取失败' });
      }
    },
    async refreshAvailability() {
      try {
        const value = await transport.read();
        if (state.settings) update({ settings: { ...state.settings, providerReady: value.providerReady, modelReady: value.modelReady, modelFourToOne: value.modelFourToOne, billingReadiness: value.billingReadiness } });
      } catch { /* A transient availability failure must not replace the settings baseline. */ }
    },
    editContext(context: string) {
      if (!isAdmin || !state.draft || state.loading) return;
      update({ draft: { ...state.draft, context }, status: '设置未保存' });
    },
    editPrice(model: string, price: number | null) {
      if (!isAdmin || !state.draft || state.loading) return;
      update({ draft: { ...state.draft, prices: { ...state.draft.prices, [model]: price } }, status: '设置未保存' });
    },
    editTemplateDefaults(patch: Partial<StudioTemplateDefaults>) {
      if (!isAdmin || !state.draft || state.loading) return;
      update({ draft: { ...state.draft, templateDefaults: { ...state.draft.templateDefaults, ...patch } }, status: '设置未保存' });
    },
    acceptCommitted(saved: SettingsResponse, submittedDraft: SettingsDraft) {
      const savedValue = validate({ ...state.settings, ...saved });
      if (!state.settings || savedValue.revision < state.settings.revision) return false;
      ++readSequence;
      update({ settings: savedValue, ...(state.draft === submittedDraft ? { draft: {
        context: savedValue.context ?? '', prices: { ...savedValue.prices }, templateDefaults: { ...savedValue.templateDefaults },
      } } : {}), error: '' });
      update({ status: studioSettingsDirty(state) ? '默认值已保存；有新的修改尚未保存' : '默认值已保存' });
      return !studioSettingsDirty(state);
    },
    async save() {
      if (!isAdmin || !state.settings || !state.draft || state.loading || state.saving || !studioSettingsDirty(state)) return false;
      let templateDefaults: StudioTemplateDefaults;
      try {
        templateDefaults = parseStudioTemplateDefaults(state.draft.templateDefaults);
      } catch (error) {
        update({ status: '未保存', error: error instanceof Error ? error.message : '统一默认设置无效，请检查后重试' });
        return false;
      }
      ++readSequence;
      const contextChanged = state.draft.context !== state.settings.context;
      const payload: SettingsWrite = { revision: state.settings.revision, prices: { ...state.draft.prices },
        templateDefaults,
        ...(contextChanged ? { context: state.draft.context, confirmContextClear: state.draft.context.trim().length === 0 } : {}) };
      const baseline = state.settings;
      const submittedDraft = state.draft;
      update({ saving: true, error: '', status: '正在保存' });
      try {
        const saved = await transport.write(payload);
        const savedValue = validate(saved);
        if (savedValue.revision <= baseline.revision) throw new Error('保存结果尚未确认，当前输入已保留，请重新读取核对');
        const value = { ...baseline, ...savedValue };
        value.contextConfigured = Boolean(value.context?.trim());
        update({ settings: value, saving: false, ...(state.draft === submittedDraft
          ? { draft: { context: value.context ?? '', prices: { ...value.prices }, templateDefaults: { ...value.templateDefaults } } } : {}) });
        update({ status: studioSettingsDirty(state) ? '有新的修改尚未保存' : '已保存' });
        return !studioSettingsDirty(state);
      } catch (error) {
        update({ saving: false, status: '未保存', error: error instanceof Error ? error.message : '保存失败，请重试' });
        return false;
      }
    },
  };
}

export type StudioSettingsController = ReturnType<typeof createStudioSettingsController>;
