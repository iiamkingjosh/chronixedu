'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  getSupportSessions,
  getSuperAdminSchools,
  startSupportSession,
  endSupportSession,
  type SupportSession,
  type SchoolListItem,
} from '@/lib/superAdminApi';
import { useToast } from '@/components/Toast';

function formatRelative(value: string): string {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  return d.toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 capitalize">
      {role}
    </span>
  );
}

// ── Modal wrapper ─────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 max-h-[75vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

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

// ── Start Session modal ───────────────────────────────────────────────────────

const startSessionSchema = z.object({
  school_id: z.string().min(1, 'Select a school'),
  user_id: z.string().uuid('Must be a valid user ID (UUID)'),
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
});

type StartSessionForm = z.infer<typeof startSessionSchema>;

function StartSessionModal({ schools, onClose, onDone }: {
  schools: SchoolListItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<StartSessionForm>({
    resolver: zodResolver(startSessionSchema),
    defaultValues: { school_id: '', user_id: '', reason: '' },
  });
  const [apiError, setApiError] = useState('');
  const [scopedToken, setScopedToken] = useState<string | null>(null);

  async function onSubmit(values: StartSessionForm) {
    setApiError('');
    try {
      const res = await startSupportSession(values);
      setScopedToken(res.scoped_token);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to start support session');
    }
  }

  if (scopedToken) {
    return (
      <Modal title="Support Session Started" onClose={onDone}>
        <div className="space-y-4">
          <p className="text-sm text-gray-600">Use this scoped token to access the school&apos;s account.</p>
          <code className="block bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs break-all text-gray-800">{scopedToken}</code>
          <p className="text-sm text-gray-500">This token expires in 2 hours.</p>
          <div className="flex justify-end pt-2">
            <button onClick={onDone} className="px-5 py-2 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002244] transition-colors">
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Start Support Session" onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Field label="School" error={errors.school_id?.message}>
          <select {...register('school_id')} className={inputClass}>
            <option value="">Select a school…</option>
            {schools.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="User ID" error={errors.user_id?.message}>
          <input {...register('user_id')} className={inputClass} placeholder="Paste the user's UUID" />
        </Field>
        <Field label="Reason" error={errors.reason?.message}>
          <textarea {...register('reason')} rows={3} className={inputClass} placeholder="Why are you starting this session?" />
        </Field>
        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002244] disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Starting…' : 'Start Session'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SuperAdminSupportPage() {
  const { show } = useToast();

  const [sessions, setSessions] = useState<SupportSession[]>([]);
  const [schools, setSchools] = useState<SchoolListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([getSupportSessions(), getSuperAdminSchools({ page: 1 })])
      .then(([sessionsData, schoolsData]) => {
        setSessions(sessionsData);
        setSchools(schoolsData.schools);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleEnd(session: SupportSession) {
    setBusyId(session.id);
    try {
      const res = await endSupportSession(session.id);
      show(`Session ended (${res.duration_minutes} min)`, 'success');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to end session', 'error');
    } finally {
      setBusyId(null);
    }
  }

  const activeSessions = sessions.filter((s) => s.status === 'active');
  const endedSessions = sessions.filter((s) => s.status === 'ended');

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">Support Sessions</h1>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="bg-[#003366] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[#002244]"
        >
          Start Session
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading && <p className="text-sm text-gray-400">Loading…</p>}

      {!loading && (
        <>
          <div className="mb-8">
            <h2 className="text-base font-semibold text-gray-900 mb-3">Active Sessions</h2>
            {activeSessions.length === 0 ? (
              <p className="text-sm text-gray-400">No active support sessions.</p>
            ) : (
              <div className="space-y-3">
                {activeSessions.map((s) => (
                  <div key={s.id} className="bg-white rounded-lg shadow-sm p-5 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-bold text-gray-900">{s.school_name}</p>
                        <RoleBadge role={s.impersonated_role} />
                      </div>
                      <p className="text-sm text-gray-600">{s.impersonated_email}</p>
                      <p className="text-sm text-gray-500 mt-1">{s.reason}</p>
                      <p className="text-xs text-gray-400 mt-1">Started {formatRelative(s.started_at)}</p>
                    </div>
                    <button
                      onClick={() => handleEnd(s)}
                      disabled={busyId === s.id}
                      className="shrink-0 px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      End Session
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h2 className="text-base font-semibold text-gray-900 mb-3">Session History</h2>
            <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
                    <th className="py-3 px-4">Admin</th>
                    <th className="py-3 px-4">School</th>
                    <th className="py-3 px-4">Impersonated</th>
                    <th className="py-3 px-4">Duration</th>
                    <th className="py-3 px-4">Reason</th>
                    <th className="py-3 px-4">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {endedSessions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-10 text-center text-gray-400">No ended sessions yet.</td>
                    </tr>
                  )}
                  {endedSessions.map((s) => (
                    <tr key={s.id}>
                      <td className="py-3 px-4 text-gray-700">{s.admin_email}</td>
                      <td className="py-3 px-4 font-semibold text-gray-900">{s.school_name}</td>
                      <td className="py-3 px-4 text-gray-700">{s.impersonated_email}</td>
                      <td className="py-3 px-4 text-gray-700">{s.duration_minutes} min</td>
                      <td className="py-3 px-4 text-gray-500 max-w-xs truncate">{s.reason}</td>
                      <td className="py-3 px-4 text-gray-700">{formatDateTime(s.started_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {modalOpen && (
        <StartSessionModal
          schools={schools}
          onClose={() => setModalOpen(false)}
          onDone={() => {
            setModalOpen(false);
            load();
          }}
        />
      )}
    </div>
  );
}
