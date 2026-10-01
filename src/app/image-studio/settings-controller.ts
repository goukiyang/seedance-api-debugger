export type SettingsValue = {
  context?: string;
  revision: number;
  contextConfigured?: boolean;
  providerReady: boolean;
  modelReady?: Record<string, boolean>;
  prices: Record<string, number | null>;
};

export type SettingsDraft = { context: string; prices: SettingsValue['prices'] };
export type SettingsWrite = { revision: number; prices: SettingsValue['prices']; context?: string; confirmContextClear?: boolean };
type SettingsState = {
  settings: SettingsValue | null;
  draft: SettingsDraft | null;
  loading: boolean;
  saving: boolean;
  error: string;
  status: string;
};
type Transport = { read: () => Promise<SettingsValue>; write: (value: SettingsWrite) => Promise<SettingsValue> };

function samePrices(a: SettingsValue['prices'], b: SettingsValue['prices']) {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
}

export function studioSettingsDirty(state: SettingsState) {
  return Boolean(state.settings && state.draft && (
    state.draft.context !== (state.settings.context ?? '') || !samePrices(state.draft.prices, state.settings.prices)
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
  function validate(value: SettingsValue) {
    if (!value || !Number.isInteger(value.revision) || !value.prices || (isAdmin && typeof value.context !== 'string')) {
      throw new Error('通用设置未完整读取，请重试');
    }
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
        validate(value);
        update({ settings: value, draft: { context: value.context ?? '', prices: { ...value.prices } }, loading: false, status: '已保存' });
      } catch (error) {
        if (sequence === readSequence) update({ loading: false, error: error instanceof Error ? error.message : '读取失败，请重试', status: '读取失败' });
      }
    },
    async refreshAvailability() {
      try {
        const value = await transport.read();
        if (state.settings) update({ settings: { ...state.settings, providerReady: value.providerReady, modelReady: value.modelReady } });
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
    async save() {
      if (!isAdmin || !state.settings || !state.draft || state.loading || state.saving || !studioSettingsDirty(state)) return;
      ++readSequence;
      const contextChanged = state.draft.context !== state.settings.context;
      const payload: SettingsWrite = { revision: state.settings.revision, prices: { ...state.draft.prices },
        ...(contextChanged ? { context: state.draft.context, confirmContextClear: state.draft.context.trim().length === 0 } : {}) };
      const baseline = state.settings;
      update({ saving: true, error: '', status: '正在保存' });
      try {
        const value = { ...baseline, ...await transport.write(payload) };
        validate(value);
        value.contextConfigured = Boolean(value.context?.trim());
        update({ settings: value, saving: false });
        update({ status: studioSettingsDirty(state) ? '有新的修改尚未保存' : '已保存，下次生成生效' });
      } catch (error) {
        update({ saving: false, status: '未保存', error: error instanceof Error ? error.message : '保存失败，请重试' });
      }
    },
  };
}

export type StudioSettingsController = ReturnType<typeof createStudioSettingsController>;
