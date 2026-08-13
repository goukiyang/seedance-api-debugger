'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

export interface AppSessionUser {
  id: string;
  name: string | null;
  username: string | null;
  email: string | null;
  avatar_url?: string | null;
  role: 'admin' | 'user';
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
  refreshUser: (options?: RefreshOptions) => Promise<AppSessionUser | null>;
  refreshCredits: (options?: RefreshOptions) => Promise<AppCreditSummary | null>;
  clearSession: () => void;
}

const CREDIT_CACHE_TTL_MS = 30_000;

const AppSessionContext = createContext<AppSessionContextValue | null>(null);

export function AppSessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppSessionUser | null>(null);
  const [credits, setCredits] = useState<AppCreditSummary | null>(null);
  const [loadingUser, setLoadingUser] = useState(false);
  const [loadingCredits, setLoadingCredits] = useState(false);
  const [hasLoadedUser, setHasLoadedUser] = useState(false);
  const [userLoadError, setUserLoadError] = useState<string | null>(null);

  const userRef = useRef<AppSessionUser | null>(null);
  const creditsRef = useRef<AppCreditSummary | null>(null);
  const loadingUserRef = useRef(false);
  const loadingCreditsRef = useRef(false);
  const hasLoadedUserRef = useRef(false);
  const lastCreditsAtRef = useRef(0);

  const refreshUser = useCallback(async (options: RefreshOptions = {}) => {
    if (!options.force && hasLoadedUserRef.current) return userRef.current;
    if (loadingUserRef.current) return userRef.current;

    loadingUserRef.current = true;
    setLoadingUser(true);
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store' });
      if (!response.ok) throw new Error('auth status failed');
      const data = await response.json();
      const nextUser = (data.user || null) as AppSessionUser | null;
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
      hasLoadedUserRef.current = true;
      setHasLoadedUser(true);
      setUserLoadError('登录状态确认失败，请刷新后重试。');
      return userRef.current;
    } finally {
      loadingUserRef.current = false;
      setLoadingUser(false);
    }
  }, []);

  const refreshCredits = useCallback(async (options: RefreshOptions = {}) => {
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
    try {
      const response = await fetch('/api/me/credits', { cache: 'no-store' });
      if (!response.ok) throw new Error('credits failed');
      const data = await response.json();
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
      creditsRef.current = null;
      setCredits(null);
      lastCreditsAtRef.current = 0;
      return null;
    } finally {
      loadingCreditsRef.current = false;
      setLoadingCredits(false);
    }
  }, []);

  const clearSession = useCallback(() => {
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

  const value = useMemo<AppSessionContextValue>(() => ({
    user,
    credits,
    loadingUser,
    loadingCredits,
    hasLoadedUser,
    userLoadError,
    refreshUser,
    refreshCredits,
    clearSession,
  }), [clearSession, credits, hasLoadedUser, loadingCredits, loadingUser, refreshCredits, refreshUser, user, userLoadError]);

  return (
    <AppSessionContext.Provider value={value}>
      {children}
    </AppSessionContext.Provider>
  );
}

export function useAppSession() {
  const context = useContext(AppSessionContext);
  if (!context) {
    throw new Error('useAppSession must be used inside AppSessionProvider');
  }
  return context;
}
