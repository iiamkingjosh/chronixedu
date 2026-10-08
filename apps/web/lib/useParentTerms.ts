'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from './api';
import type { SessionLike, TermLike } from './termOrder';
import { termsToLookBackOn, defaultTermId, lagosToday, type TermChoice } from './parentTerms';

/** The terms a parent can choose between, and the chosen one (the current term to start with). */
export function useParentTerms(schoolId: string | null | undefined): {
  choices: TermChoice[];
  termId: string | null;
  setTermId: (id: string) => void;
  loading: boolean;
  error: string;
} {
  const [choices, setChoices] = useState<TermChoice[]>([]);
  const [termId, setTermId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<{ success: boolean; data: Array<SessionLike<TermLike & { end_date?: string }>> }>(`/api/schools/${schoolId}/sessions`)
      .then(({ data }) => {
        if (cancelled) return;
        const list = termsToLookBackOn(data, lagosToday());
        setChoices(list);
        setTermId(prev => prev ?? defaultTermId(list));
        setError(list.length === 0 ? 'No term has begun yet.' : '');
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load terms'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId]);

  return { choices, termId, setTermId, loading, error };
}
