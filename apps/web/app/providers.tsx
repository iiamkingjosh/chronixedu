'use client';

import { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback } from 'react';
import { useRouter } from 'next/navigation';

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
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  schoolId: string | null;
  loading: boolean;
  setAuth: (user: AuthUser, token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const t = localStorage.getItem('chronixedu_token');
      const u = localStorage.getItem('chronixedu_user');
      if (t && u) {
        setToken(t);
        setUser(JSON.parse(u) as AuthUser);
      }
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
    localStorage.removeItem('chronixedu_token');
    localStorage.removeItem('chronixedu_user');
  }, []);

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

  return (
    <AuthContext.Provider
      value={{ user, token, schoolId: user?.school_id ?? null, loading, setAuth, logout }}
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
