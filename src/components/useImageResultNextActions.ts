'use client';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ContentKey } from '@/lib/content-reactions/types';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { createImageResultHandoff, findImageResultHandoff } from '@/lib/image-result-next/client';
import { createImageResultNextController, imageResultNextCapabilities, imageResultNextIdentity, type ImageResultNextContext } from '@/lib/image-result-next/controller';

export function useImageResultNextActions({ sourceKey, resultId, scope, enabled = true }: {
  sourceKey?: ContentKey; resultId?: string; scope?: string; enabled?: boolean;
}) {
  const { user, sessionChanged } = useAppSession();
  const context: ImageResultNextContext = { sourceKey, resultId, scope, enabled, accountId: user?.id || '', admin: user?.role === 'admin', sessionChanged };
  const latest = useRef(context); latest.current = context;
  const holder = useRef<ReturnType<typeof createImageResultNextController> | null>(null);
  if (!holder.current) holder.current = createImageResultNextController({
    context: () => latest.current, blocked: isClientSessionBlocked,
    find: findImageResultHandoff, create: createImageResultHandoff,
    currentUrl: () => window.location.href,
    openTarget: () => {
      const target = window.open('about:blank', '_blank');
      if (!target) return null;
      try {
        target.opener = null; target.document.title = '正在导入图片'; target.document.documentElement.lang = 'zh-CN';
        const status = target.document.createElement('p'); status.textContent = '正在核对原图，完成后打开工作区。'; status.setAttribute('role', 'status');
        target.document.body.append(status);
      } catch (cause) { target.close(); throw cause; }
      return { close: () => target.close(), closed: () => target.closed, replace: destination => target.location.replace(destination) };
    },
  });
  const controller = holder.current;
  const identity = imageResultNextIdentity(context, isClientSessionBlocked());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { controller.synchronize(); }, [controller, identity]);
  const visible = state.identity === identity;
  const busy = visible ? state.busy : null;
  return { open: controller.open, busy, message: visible ? state.message : '', destination: visible ? state.destination : '',
    ...imageResultNextCapabilities(context, isClientSessionBlocked(), busy) };
}
export type ImageResultNextActionsController = ReturnType<typeof useImageResultNextActions>;
