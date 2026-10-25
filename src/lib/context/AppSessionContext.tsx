'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { setUploadSessionOwner } from '@/lib/http/upload-session';
import { clientSessionNotice, isClientSessionBlocked, watchSessionExit, type SessionBoundaryReason } from '@/lib/auth/client-session-boundary';
import { setImageReadSessionOwner } from '@/lib/media/image-read-session';
import { getPageExitRisk, runApprovedPageExit } from '@/lib/hooks/page-exit-guard';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useProductDialog } from '@/components/useProductDialog';
import dialogStyles from '@/components/ProductDialog.module.css';
import boundaryStyles from './AppSessionBoundary.module.css';

export interface AppSessionUser {
  id: string;
  name: string | null;
  username: string | null;
  email: string | null;
  avatar_url?: string | null;
  role: 'admin' | 'user';
  account_type?: 'internal' | 'external' | string | null;
  feature_profile_id?: string | null;
  feishu?: { user_id?: string | null; open_id?: string | null; union_id?: string | null } | null;
}

export interface AppCreditSummary {
  available: number;
  frozen_credits: number;
  monthly_used: number;
}

interface RefreshOptions {
  force?: boolean;
}

interface AppSessionContextValue {
  user: AppSessionUser | null;
  credits: AppCreditSummary | null;
  loadingUser: boolean;
  loadingCredits: boolean;
  hasLoadedUser: boolean;
  userLoadError: string | null;
  sessionChanged: boolean;
  refreshUser: (options?: RefreshOptions) => Promise<AppSessionUser | null>;
  refreshCredits: (options?: RefreshOptions) => Promise<AppCreditSummary | null>;
  clearSession: () => void;
}

const CREDIT_CACHE_TTL_MS = 30_000;

const AppSessionContext = createContext<AppSessionContextValue | null>(null);

function SessionChangedNotice({ reason }: { reason: SessionBoundaryReason }) {
  const notice = clientSessionNotice(reason);
  const dialog = useRef<HTMLDialogElement>(null);
  const login = useRef<HTMLButtonElement>(null);
  const { confirm, productDialog } = useProductDialog();
  const [error, setError] = useState('');
  const deciding = useRef(false);
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, initialFocusRef: login, onDismiss: () => {}, dismissOnOutside: false, dismissOnEscape: false, restoreFocus: false });
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function leave() {
    if (deciding.current) return;
    deciding.current = true;
    try {
      const risk = getPageExitRisk();
      if (risk.busy.length) { setError(`${risk.busy.join('、')}，请等当前操作结果确认后再离开。`); return; }
      if (risk.unsaved.length && !await confirm(`${risk.unsaved.join('、')}尚未保存。前往登录会离开本页，未能保存的输入可能丢失；已按账号保存的草稿保留。确定离开吗？`, { title: '前往登录', confirmLabel: '离开并登录', anchor: null })) return;
      if (!runApprovedPageExit(() => window.location.replace('/login'), risk.signature)) setError('页面内容或操作状态已变化，请确认后重试。');
    } finally { deciding.current = false; }
  }
  return createPortal(<><dialog ref={dialog} className={dialogStyles.dialog} aria-modal="true" aria-labelledby="sd2-session-changed-title">
    <header className={dialogStyles.header}><h2 id="sd2-session-changed-title">{notice.title}</h2></header>
    <p className={dialogStyles.message}>{notice.message}</p>
    {error && <p className={dialogStyles.message} role="status">{error}</p>}
    <footer className={dialogStyles.actions}><button ref={login} type="button" className={dialogStyles.primary} onClick={() => void leave()}>前往登录</button></footer>
  </dialog>{productDialog}</>, document.body);
}

export function AppSessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppSessionUser | null>(null);
  const [credits, setCredits] = useState<AppCreditSummary | null>(null);
  const [loadingUser, setLoadingUser] = useState(false);
  const [loadingCredits, setLoadingCredits] = useState(false);
  const [hasLoadedUser, setHasLoadedUser] = useState(false);
  const [userLoadError, setUserLoadError] = useState<string | null>(null);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [sessionBoundaryReason, setSessionBoundaryReason] = useState<SessionBoundaryReason>('logged_out');
  const workspace = useRef<HTMLDivElement>(null);

  const userRef = useRef<AppSessionUser | null>(null);
  const creditsRef = useRef<AppCreditSummary | null>(null);
  const loadingUserRef = useRef(false);
  const loadingCreditsRef = useRef(false);
  const hasLoadedUserRef = useRef(false);
  const lastCreditsAtRef = useRef(0);
  const sessionEpoch = useRef(0);
  const userRequest = useRef<AbortController | null>(null);
  const creditsRequest = useRef<AbortController | null>(null);

  const refreshUser = useCallback(async (options: RefreshOptions = {}) => {
    if (isClientSessionBlocked()) return null;
    if (!options.force && hasLoadedUserRef.current) return userRef.current;
    if (loadingUserRef.current) return userRef.current;

    loadingUserRef.current = true;
    setLoadingUser(true);
    const epoch = sessionEpoch.current;
    const controller = new AbortController();
    userRequest.current = controller;
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('auth status failed');
      const data = await response.json();
      if (controller.signal.aborted || sessionEpoch.current !== epoch) return null;
      const nextUser = (data.user || null) as AppSessionUser | null;
      if (nextUser?.id !== userRef.current?.id) {
        sessionEpoch.current++;
        creditsRequest.current?.abort();
        creditsRequest.current = null;
        loadingCreditsRef.current = false;
        setLoadingCredits(false);
        creditsRef.current = null;
        setCredits(null);
        lastCreditsAtRef.current = 0;
      }
      setUploadSessionOwner(nextUser?.id || null);
      userRef.current = nextUser;
      setUser(nextUser);
      setUserLoadError(null);
      if (!nextUser) {
        creditsRef.current = null;
        setCredits(null);
        lastCreditsAtRef.current = 0;
      }
      hasLoadedUserRef.current = true;
      setHasLoadedUser(true);
      return nextUser;
    } catch {
      if (controller.signal.aborted || sessionEpoch.current !== epoch) return null;
      setUploadSessionOwner(null);
      hasLoadedUserRef.current = true;
      setHasLoadedUser(true);
      setUserLoadError('登录状态确认失败，请刷新后重试。');
      return userRef.current;
    } finally {
      if (userRequest.current === controller) {
        userRequest.current = null;
        loadingUserRef.current = false;
        setLoadingUser(false);
      }
    }
  }, []);

  const refreshCredits = useCallback(async (options: RefreshOptions = {}) => {
    if (isClientSessionBlocked()) return null;
    const currentUser = userRef.current;
    if (!currentUser) return null;
    const now = Date.now();
    if (
      !options.force
      && creditsRef.current
      && now - lastCreditsAtRef.current < CREDIT_CACHE_TTL_MS
    ) {
      return creditsRef.current;
    }
    if (loadingCreditsRef.current) return creditsRef.current;

    loadingCreditsRef.current = true;
    setLoadingCredits(true);
    const epoch = sessionEpoch.current;
    const controller = new AbortController();
    creditsRequest.current = controller;
    try {
      const response = await fetch('/api/me/credits', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('credits failed');
      const data = await response.json();
      if (controller.signal.aborted || sessionEpoch.current !== epoch || userRef.current?.id !== currentUser.id) return null;
      const nextCredits = {
        available: Number(data.available || 0),
        frozen_credits: Number(data.frozen_credits || 0),
        monthly_used: Number(data.monthly_used || 0),
      };
      creditsRef.current = nextCredits;
      setCredits(nextCredits);
      lastCreditsAtRef.current = Date.now();
      return nextCredits;
    } catch {
      if (controller.signal.aborted || sessionEpoch.current !== epoch || userRef.current?.id !== currentUser.id) return null;
      creditsRef.current = null;
      setCredits(null);
      lastCreditsAtRef.current = 0;
      return null;
    } finally {
      if (creditsRequest.current === controller) {
        creditsRequest.current = null;
        loadingCreditsRef.current = false;
        setLoadingCredits(false);
      }
    }
  }, []);

  const clearSession = useCallback(() => {
    sessionEpoch.current++;
    userRequest.current?.abort();
    creditsRequest.current?.abort();
    userRequest.current = null;
    creditsRequest.current = null;
    setUploadSessionOwner(null);
    setImageReadSessionOwner('');
    userRef.current = null;
    creditsRef.current = null;
    loadingUserRef.current = false;
    loadingCreditsRef.current = false;
    hasLoadedUserRef.current = false;
    lastCreditsAtRef.current = 0;
    setUser(null);
    setCredits(null);
    setLoadingUser(false);
    setLoadingCredits(false);
    setHasLoadedUser(false);
    setUserLoadError(null);
  }, []);

  useEffect(() => watchSessionExit(reason => {
    sessionEpoch.current++;
    userRequest.current?.abort(); creditsRequest.current?.abort();
    userRequest.current = null; creditsRequest.current = null;
    loadingUserRef.current = false; loadingCreditsRef.current = false;
    creditsRef.current = null; lastCreditsAtRef.current = 0;
    setUploadSessionOwner(null); setImageReadSessionOwner('');
    // Keep the old user snapshot and mounted workspace only to preserve input.
    // The locked page cannot reload a session; background writers check the
    // synchronous blocked flag separately before issuing another mutation.
    setLoadingUser(false); setLoadingCredits(false); setCredits(null);
    setUserLoadError(clientSessionNotice(reason).message);
    setSessionBoundaryReason(reason);
    setSessionChanged(true);
    workspace.current?.setAttribute('inert', '');
  }), []);

  const value = useMemo<AppSessionContextValue>(() => ({
    user,
    credits,
    loadingUser,
    loadingCredits,
    hasLoadedUser,
    userLoadError,
    sessionChanged,
    refreshUser,
    refreshCredits,
    clearSession,
  }), [clearSession, credits, hasLoadedUser, loadingCredits, loadingUser, refreshCredits, refreshUser, sessionChanged, user, userLoadError]);

  return (
    <AppSessionContext.Provider value={value}>
      <div ref={workspace} className={boundaryStyles.workspace}>{children}</div>
      {sessionChanged && <SessionChangedNotice reason={sessionBoundaryReason} />}
    </AppSessionContext.Provider>
  );
}

/** For components that may render outside the provider (returns null there). */
export function useOptionalAppSession() { return useContext(AppSessionContext); }
export function useAppSession() {
  const context = useContext(AppSessionContext);
  if (!context) {
    throw new Error('useAppSession must be used inside AppSessionProvider');
  }
  return context;
}
