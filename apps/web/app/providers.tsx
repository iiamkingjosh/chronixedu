'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

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
