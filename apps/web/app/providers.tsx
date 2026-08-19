'use client';

import { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel'];

export interface AuthUser {
  user_id: string;
  school_id: string | null;
  role: string;
  email: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  subscription_tier?: string | null;
  support_code?: string;
  must_change_password?: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  schoolId: string | null;
  subscriptionTier: string | null;
  supportCode: string | null;
  loading: boolean;
  setAuth: (user: AuthUser, token: string) => void;
  logout: () => void;
  isImpersonating: boolean;
  startImpersonation: (user: AuthUser, token: string, sessionId: string) => void;
  exitImpersonation: () => string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isImpersonating, setIsImpersonating] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const t = localStorage.getItem('chronixedu_token');
      const u = localStorage.getItem('chronixedu_user');
      if (t && u) {
        setToken(t);
        setUser(JSON.parse(u) as AuthUser);
      }
      setIsImpersonating(!!localStorage.getItem('chronixedu_impersonator_token'));
    } catch {
      localStorage.removeItem('chronixedu_token');
      localStorage.removeItem('chronixedu_user');
    } finally {
      setLoading(false);
    }
  }, []);

  function setAuth(u: AuthUser, t: string) {
    setUser(u);
    setToken(t);
    localStorage.setItem('chronixedu_token', t);
    localStorage.setItem('chronixedu_user', JSON.stringify(u));
  }

  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    setIsImpersonating(false);
    localStorage.removeItem('chronixedu_token');
    localStorage.removeItem('chronixedu_user');
    localStorage.removeItem('chronixedu_impersonator_token');
    localStorage.removeItem('chronixedu_impersonator_user');
    localStorage.removeItem('chronixedu_support_session_id');
  }, []);

  /** Backs up the current (real admin) session, then switches the active
   *  session to the impersonated user's scoped token. */
  function startImpersonation(impersonatedUser: AuthUser, scopedToken: string, sessionId: string) {
    if (token && user) {
      localStorage.setItem('chronixedu_impersonator_token', token);
      localStorage.setItem('chronixedu_impersonator_user', JSON.stringify(user));
    }
    localStorage.setItem('chronixedu_support_session_id', sessionId);
    setAuth(impersonatedUser, scopedToken);
    setIsImpersonating(true);
  }

  /** Restores the real admin's session. Returns the support session ID that
   *  was active, so the caller can tell the API to end it (using the
   *  now-restored admin auth) — or null if nothing was being impersonated. */
  function exitImpersonation(): string | null {
    const adminToken = localStorage.getItem('chronixedu_impersonator_token');
    const adminUser = localStorage.getItem('chronixedu_impersonator_user');
    const sessionId = localStorage.getItem('chronixedu_support_session_id');
    localStorage.removeItem('chronixedu_impersonator_token');
    localStorage.removeItem('chronixedu_impersonator_user');
    localStorage.removeItem('chronixedu_support_session_id');
    setIsImpersonating(false);
    if (adminToken && adminUser) {
      setAuth(JSON.parse(adminUser) as AuthUser, adminToken);
    } else {
      logout();
    }
    return sessionId;
  }

  // Auto-logout after 10 minutes with no mouse/keyboard/touch activity — protects
  // accounts left open on shared school computers. The 1h server JWT expiry is
  // the hard backstop regardless, even if localStorage is tampered with directly.
  useEffect(() => {
    if (!user) return;

    function resetIdleTimer() {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => {
        logout();
        router.replace('/login?reason=idle');
      }, IDLE_TIMEOUT_MS);
    }

    ACTIVITY_EVENTS.forEach(event => window.addEventListener(event, resetIdleTimer));
    resetIdleTimer();

    return () => {
      ACTIVITY_EVENTS.forEach(event => window.removeEventListener(event, resetIdleTimer));
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [user, logout, router]);

  // A temp password is only shown once — force a stop at /change-password
  // right after login (and on any later navigation) until it's replaced.
  useEffect(() => {
    if (!user?.must_change_password) return;
    if (pathname === '/change-password') return;
    router.replace('/change-password');
  }, [user, pathname, router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        schoolId: user?.school_id ?? null,
        subscriptionTier: user?.subscription_tier ?? null,
        supportCode: user?.support_code ?? null,
        loading,
        setAuth,
        logout,
        isImpersonating,
        startImpersonation,
        exitImpersonation,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
