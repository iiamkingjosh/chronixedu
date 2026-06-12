'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TermOption {
  id: string;
  name: string;
  sessionId: string;
  sessionName: string;
  isCurrent: boolean;
}

export interface ClassOption {
  id: string;
  name: string;
  level: string;
  stream: string | null;
}

interface SessionWithTermsResponse {
  id: string;
  name: string;
  terms: Array<{ id: string; name: string; is_current: boolean }>;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

export function formatCurrency(amount: number | string): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type InvoiceStatus = 'unpaid' | 'partial' | 'paid';

export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  unpaid: 'Unpaid',
  partial: 'Partially Paid',
  paid: 'Paid',
};

export const STATUS_STYLES: Record<InvoiceStatus, string> = {
  unpaid: 'bg-red-50 text-red-700 border-red-200',
  partial: 'bg-amber-50 text-amber-700 border-amber-200',
  paid: 'bg-green-50 text-green-700 border-green-200',
};

export function statusBadgeClass(status: InvoiceStatus): string {
  return `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_STYLES[status]}`;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

export type ToastFn = (message: string, type?: 'success' | 'error') => void;

export function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show: ToastFn = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

export function ToastBanner({ toast }: { toast: { message: string; type: 'success' | 'error' } | null }) {
  if (!toast) return null;
  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
      toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
    }`}>
      {toast.message}
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ── Term/class context hook ──────────────────────────────────────────────────

export function useTermsAndClasses() {
  const { schoolId } = useAuth();
  const [terms, setTerms] = useState<TermOption[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [currentTermId, setCurrentTermId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    Promise.all([
      apiFetch<{ success: boolean; data: SessionWithTermsResponse[] }>(`/api/schools/${schoolId}/sessions`),
      apiFetch<{ success: boolean; data: ClassOption[] }>(`/api/schools/${schoolId}/classes`),
      apiFetch<{ success: boolean; data: { term: { id: string } | null } }>(`/api/schools/${schoolId}/current-context`),
    ])
      .then(([sessionsRes, classesRes, contextRes]) => {
        if (cancelled) return;

        const flatTerms: TermOption[] = [];
        for (const session of sessionsRes.data) {
          for (const term of session.terms) {
            flatTerms.push({
              id: term.id,
              name: term.name,
              sessionId: session.id,
              sessionName: session.name,
              isCurrent: term.is_current,
            });
          }
        }

        setTerms(flatTerms);
        setClasses(classesRes.data);
        setCurrentTermId(contextRes.data.term?.id ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load terms and classes');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId]);

  return { terms, classes, currentTermId, loading, error };
}
