'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createStudioSettingsController, studioSettingsDirty } from './settings-controller';

async function readSettingsResponse(response: Response) {
  const value = await response.json().catch(() => { throw new Error('服务暂时无法响应，请重试'); });
  if (!response.ok) throw new Error(value.error || '通用设置请求失败，请重试');
  return value;
}

export function useStudioSettings(userId: string, isAdmin: boolean) {
  const { controller } = useMemo(() => ({ userId, controller: createStudioSettingsController(isAdmin, {
      read: async () => readSettingsResponse(await fetch('/api/image-studio/settings', { cache: 'no-store' })),
      write: async value => readSettingsResponse(await fetch('/api/image-studio/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
      })),
    }),
  }), [userId, isAdmin]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const dirty = studioSettingsDirty(state);
  useEffect(() => {
    void controller.load();
    const refresh = () => { if (document.visibilityState === 'visible') void controller.refreshAvailability(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.cancelRead();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [controller]);
  useEffect(() => {
    if (!dirty && !state.saving) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, state.saving]);
  return { ...state, dirty, controller };
}
