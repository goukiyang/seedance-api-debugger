'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createStudioSettingsController, studioSettingsDirty } from './settings-controller';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import { fetchReadWithRetry } from '@/lib/http/read-retry';

async function readSettingsResponse(response: Response) {
  const value = await response.json().catch(() => { throw new Error('服务暂时无法响应，请重试'); });
  if (!response.ok) throw new Error(value.error || '通用设置请求失败，请重试');
  return value;
}

export function useStudioSettings(userId: string, isAdmin: boolean) {
  const broadcast = useRef<BroadcastChannel | null>(null);
  const { controller } = useMemo(() => ({ userId, controller: createStudioSettingsController(isAdmin, {
      read: async signal => readSettingsResponse(await fetchReadWithRetry('/api/image-studio/settings', { signal })),
      write: async value => readSettingsResponse(await fetch('/api/image-studio/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
      })),
      onSaved: revision => { broadcast.current?.postMessage({ revision }); },
    }),
  }), [userId, isAdmin]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const dirty = studioSettingsDirty(state);
  useEffect(() => {
    controller.activate();
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`studio-settings:${userId}`);
    broadcast.current = channel;
    if (channel) channel.onmessage = event => {
      const revision = event.data?.revision;
      if (Number.isSafeInteger(revision) && revision > (controller.getSnapshot().settings?.revision ?? -1)) controller.invalidate(revision);
    };
    void controller.load();
    const refresh = () => { if (document.visibilityState === 'visible') void controller.load(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.dispose();
      channel?.close();
      if (broadcast.current === channel) broadcast.current = null;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [controller, userId]);
  usePageExitRisk({
    unsaved: dirty ? ['图片通用设置'] : [],
    busy: state.saving ? ['通用设置正在保存'] : [],
    revision: JSON.stringify({ context: state.draft?.context, prices: state.draft?.prices, templateDefaults: state.draft?.templateDefaults }),
  });
  return { ...state, dirty, controller };
}
