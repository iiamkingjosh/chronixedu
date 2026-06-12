'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

// TEMP DEV AUTH — remove this block and the auto-login effect below to revert
const DEV_EMAIL = 'superadmin@chronixedu.com';
const DEV_PASSWORD = 'TestPassword123';
const DEV_SCHOOL_ID = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface AuthUser {
  user_id: string;
  school_id: string | null;
  role: string;
  email: string;
  title?: string;
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

  useEffect(() => {
    try {
      const t = localStorage.getItem('chronixedu_token');
      const u = localStorage.getItem('chronixedu_user');
      if (t && u) {
        setToken(t);
        setUser(JSON.parse(u) as AuthUser);
        setLoading(false);
        return;
      }
    } catch {
      localStorage.removeItem('chronixedu_token');
      localStorage.removeItem('chronixedu_user');
    }

    // TEMP DEV AUTH — auto-login as the super admin for local testing
    fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
    })
      .then(res => res.json())
      .then(json => {
        const data = json.data ?? json;
        if (data.access_token && data.user) {
          const devUser: AuthUser = { ...data.user, school_id: data.user.school_id ?? DEV_SCHOOL_ID };
          setAuth(devUser, data.access_token);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function setAuth(u: AuthUser, t: string) {
    setUser(u);
    setToken(t);
    localStorage.setItem('chronixedu_token', t);
    localStorage.setItem('chronixedu_user', JSON.stringify(u));
  }

  function logout() {
    setUser(null);
    setToken(null);
    localStorage.removeItem('chronixedu_token');
    localStorage.removeItem('chronixedu_user');
  }

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
