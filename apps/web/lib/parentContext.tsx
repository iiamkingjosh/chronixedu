'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

const SELECTED_CHILD_KEY = 'chronixedu_parent_child';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LinkedChild {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  photo_url: string | null;
  class_id: string | null;
  class_name: string | null;
  class_level: string | null;
  relationship_type: string;
  is_primary_contact: boolean;
}

interface ParentContextValue {
  children: LinkedChild[];
  selectedChild: LinkedChild | null;
  setSelectedChildId: (id: string) => void;
  loading: boolean;
  error: string;
}

const ParentContext = createContext<ParentContextValue | null>(null);

export function ParentProvider({ children }: { children: ReactNode }) {
  const { schoolId } = useAuth();
  const [linkedChildren, setLinkedChildren] = useState<LinkedChild[]>([]);
  const [selectedChildId, setSelectedChildIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    apiFetch<{ success: boolean; data: LinkedChild[] }>(`/api/schools/${schoolId}/parent/children`)
      .then(({ data }) => {
        if (cancelled) return;
        setLinkedChildren(data);
        const stored = localStorage.getItem(SELECTED_CHILD_KEY);
        const valid = stored && data.some(c => c.student_id === stored);
        setSelectedChildIdState(valid ? stored : (data[0]?.student_id ?? null));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load children');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId]);

  function setSelectedChildId(id: string) {
    setSelectedChildIdState(id);
    localStorage.setItem(SELECTED_CHILD_KEY, id);
  }

  const selectedChild = linkedChildren.find(c => c.student_id === selectedChildId) ?? null;

  return (
    <ParentContext.Provider
      value={{ children: linkedChildren, selectedChild, setSelectedChildId, loading, error }}
    >
      {children}
    </ParentContext.Provider>
  );
}

export function useParentContext() {
  const ctx = useContext(ParentContext);
  if (!ctx) throw new Error('useParentContext must be used within ParentProvider');
  return ctx;
}
