'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Term {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
}

interface Session {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
  terms: Term[];
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const sessionSchema = z.object({
  name:       z.string().min(1, 'Name is required').regex(/^\d{4}\/\d{4}$/, 'Format: 2024/2025'),
  start_date: z.string().min(1, 'Start date required'),
  end_date:   z.string().min(1, 'End date required'),
});

const termSchema = z.object({
  name:       z.string().min(1, 'Name is required'),
  start_date: z.string().min(1, 'Start date required'),
  end_date:   z.string().min(1, 'End date required'),
});

type SessionForm = z.infer<typeof sessionSchema>;
type TermForm    = z.infer<typeof termSchema>;

// ── Toast ─────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };
  return { toast, show };
}

// ── Modal wrapper ─────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
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

// ── Field helper ──────────────────────────────────────────────────────────────

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';

// ── Create Session Modal ──────────────────────────────────────────────────────

function CreateSessionModal({ schoolId, onClose, onCreated }: {
  schoolId: string;
  onClose: () => void;
  onCreated: (s: Session) => void;
}) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<SessionForm>({
    resolver: zodResolver(sessionSchema),
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: SessionForm) {
    setApiError('');
    try {
      const res = await apiFetch<{ success: boolean; data: Session }>(
        `/api/schools/${schoolId}/sessions`,
        { method: 'POST', body: JSON.stringify(values) }
      );
      onCreated(res.data);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to create session');
    }
  }

  return (
    <Modal title="New Academic Session" onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Field label="Session Name (e.g. 2024/2025)" error={errors.name?.message}>
          <input {...register('name')} className={inputClass} placeholder="2024/2025" />
        </Field>
        <Field label="Start Date" error={errors.start_date?.message}>
          <input type="date" {...register('start_date')} className={inputClass} />
        </Field>
        <Field label="End Date" error={errors.end_date?.message}>
          <input type="date" {...register('end_date')} className={inputClass} />
        </Field>
        {apiError && <p className="text-sm text-red-600">{apiError}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Creating…' : 'Create Session'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Add Term Modal ────────────────────────────────────────────────────────────

function AddTermModal({ schoolId, sessionId, onClose, onAdded }: {
  schoolId: string;
  sessionId: string;
  onClose: () => void;
  onAdded: (t: Term) => void;
}) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<TermForm>({
    resolver: zodResolver(termSchema),
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: TermForm) {
    setApiError('');
    try {
      const res = await apiFetch<{ success: boolean; data: Term }>(
        `/api/schools/${schoolId}/sessions/${sessionId}/terms`,
        { method: 'POST', body: JSON.stringify(values) }
      );
      onAdded(res.data);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to add term');
    }
  }

  return (
    <Modal title="Add Term" onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Field label="Term Name (e.g. First Term)" error={errors.name?.message}>
          <input {...register('name')} className={inputClass} placeholder="First Term" />
        </Field>
        <Field label="Start Date" error={errors.start_date?.message}>
          <input type="date" {...register('start_date')} className={inputClass} />
        </Field>
        <Field label="End Date" error={errors.end_date?.message}>
          <input type="date" {...register('end_date')} className={inputClass} />
        </Field>
        {apiError && <p className="text-sm text-red-600">{apiError}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Adding…' : 'Add Term'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Activate Confirmation Modal ───────────────────────────────────────────────

function ActivateModal({ session, schoolId, onClose, onActivated }: {
  session: Session;
  schoolId: string;
  onClose: () => void;
  onActivated: () => void;
}) {
  const [step, setStep]     = useState<1 | 2>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');

  async function confirm() {
    setLoading(true);
    setError('');
    try {
      await apiFetch(`/api/schools/${schoolId}/sessions/${session.id}/activate`, {
        method: 'PATCH',
        body: JSON.stringify({ confirm: true }),
      });
      onActivated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Activation failed');
      setLoading(false);
    }
  }

  return (
    <Modal title="Activate Session" onClose={onClose}>
      {step === 1 ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            You are about to activate <strong>{session.name}</strong> as the current academic session.
            All result entry, reporting, and dashboards will switch to this session.
          </p>
          <p className="text-sm font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
            Any previously active session will be deactivated. This action affects all staff and students.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
            <button
              onClick={() => setStep(2)}
              className="px-5 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700"
            >
              Continue
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-800 font-medium">
            Final confirmation — activate <span className="text-slate-900">{session.name}</span>?
          </p>
          <p className="text-xs text-gray-500">
            This will immediately update the active session school-wide.
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
            <button
              onClick={confirm}
              disabled={loading}
              className="px-5 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {loading ? 'Activating…' : 'Yes, Activate Session'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AcademicStructurePage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();
  const [sessions, setSessions]         = useState<Session[]>([]);
  const [loading, setLoading]           = useState(true);
  const [showCreateSession, setShowCreateSession]   = useState(false);
  const [addTermFor, setAddTermFor]                 = useState<Session | null>(null);
  const [activateSession, setActivateSession]       = useState<Session | null>(null);
  const [expandedSession, setExpandedSession]       = useState<string | null>(null);

  useEffect(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: Session[] }>(`/api/schools/${schoolId}/sessions`)
      .then(res => {
        setSessions(res.data);
        const current = res.data.find(s => s.is_current);
        if (current) setExpandedSession(current.id);
      })
      .catch(() => show('Failed to load sessions', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  function handleSessionCreated(s: Session) {
    setSessions(prev => [s, ...prev]);
    setShowCreateSession(false);
    setExpandedSession(s.id);
    show('Session created');
  }

  function handleTermAdded(sessionId: string, term: Term) {
    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, terms: [...(s.terms ?? []), term] } : s
    ));
    setAddTermFor(null);
    show('Term added');
  }

  function handleActivated() {
    setSessions(prev => prev.map(s =>
      s.id === activateSession!.id ? { ...s, is_current: true } : { ...s, is_current: false }
    ));
    show(`${activateSession!.name} is now the active session`);
    setActivateSession(null);
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-64">
        <div className="text-gray-500 text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 mb-1">Academic Structure</h1>
          <p className="text-sm text-gray-500">Manage sessions and terms</p>
        </div>
        <button
          onClick={() => setShowCreateSession(true)}
          className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700"
        >
          + New Session
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-sm">No sessions yet. Create your first academic session.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {sessions.map(session => (
            <div key={session.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {/* Session header */}
              <div
                className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
                onClick={() => setExpandedSession(expandedSession === session.id ? null : session.id)}
              >
                <div className="flex items-center gap-3">
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${expandedSession === session.id ? 'rotate-90' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900 text-sm">{session.name}</span>
                      {session.is_current && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                          Active
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {session.start_date?.slice(0, 10)} — {session.end_date?.slice(0, 10)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  {!session.is_current && (
                    <button
                      onClick={() => setActivateSession(session)}
                      className="px-3 py-1.5 text-xs font-medium text-amber-700 border border-amber-300 rounded-lg hover:bg-amber-50"
                    >
                      Activate
                    </button>
                  )}
                </div>
              </div>

              {/* Terms list */}
              {expandedSession === session.id && (
                <div className="border-t border-gray-100 px-5 py-4 bg-gray-50">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Terms</p>
                    <button
                      onClick={() => setAddTermFor(session)}
                      className="text-xs font-medium text-slate-700 hover:text-slate-900 border border-slate-300 rounded-md px-2.5 py-1 hover:bg-white"
                    >
                      + Add Term
                    </button>
                  </div>

                  {(!session.terms || session.terms.length === 0) ? (
                    <p className="text-xs text-gray-400 py-2">No terms added yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {session.terms.map(term => (
                        <div key={term.id} className="flex items-center justify-between bg-white rounded-lg px-4 py-3 border border-gray-200">
                          <div>
                            <p className="text-sm font-medium text-gray-800">{term.name}</p>
                            <p className="text-xs text-gray-500">
                              {term.start_date?.slice(0, 10)} — {term.end_date?.slice(0, 10)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showCreateSession && schoolId && (
        <CreateSessionModal
          schoolId={schoolId}
          onClose={() => setShowCreateSession(false)}
          onCreated={handleSessionCreated}
        />
      )}

      {addTermFor && schoolId && (
        <AddTermModal
          schoolId={schoolId}
          sessionId={addTermFor.id}
          onClose={() => setAddTermFor(null)}
          onAdded={term => handleTermAdded(addTermFor.id, term)}
        />
      )}

      {activateSession && schoolId && (
        <ActivateModal
          session={activateSession}
          schoolId={schoolId}
          onClose={() => setActivateSession(null)}
          onActivated={handleActivated}
        />
      )}
    </div>
  );
}
