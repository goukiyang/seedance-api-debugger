'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { requestVideoPricing, type PublicVideoPricing, type VideoPricingRequest } from '@/lib/pricing-client';

export function useVideoPricing(input: VideoPricingRequest, enabled = true) {
  const { user, hasLoadedUser, loadingUser, sessionChanged, refreshUser } = useAppSession();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; quote: PublicVideoPricing | null; error: string; loading: boolean }>({ key: '', quote: null, error: '', loading: false });
  const refresh = useCallback(() => setRetry(value => value + 1), []);
  const key = JSON.stringify({ owner: user?.id, ...input, enabled, retry, sessionChanged });
  useEffect(() => {
    if (enabled && !hasLoadedUser && !loadingUser && !sessionChanged) void refreshUser();
  }, [enabled, hasLoadedUser, loadingUser, sessionChanged, refreshUser]);
  useEffect(() => {
    const listener = () => refresh(); window.addEventListener('sd2:video-pricing-changed', listener);
    return () => window.removeEventListener('sd2:video-pricing-changed', listener);
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    if (!enabled || !hasLoadedUser || !user || sessionChanged || !input.model || !Number.isFinite(input.duration) || input.duration <= 0) {
      setState({ key, quote: null,
        error: !enabled ? '' : sessionChanged ? '账号状态已变化，请重新确认登录' : hasLoadedUser && !user ? '请先登录后读取报价' : '',
        loading: enabled && !hasLoadedUser }); return () => controller.abort();
    }
    setState({ key, quote: null, error: '', loading: true });
    const timer = window.setTimeout(() => {
      void requestVideoPricing(input, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), user.id)
        .then(quote => { if (!controller.signal.aborted) setState({ key, quote, error: '', loading: false }); })
        .catch(error => { if (!controller.signal.aborted) setState({ key, quote: null, error: error instanceof Error ? error.message : '报价暂不可用，请重新报价', loading: false }); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // key binds the complete input, account and retry generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hasLoadedUser]);
  return { quote: state.key === key ? state.quote : null, loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : '', refresh };
}
