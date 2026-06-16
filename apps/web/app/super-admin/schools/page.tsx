'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  getSuperAdminSchools,
  suspendSchool,
  reactivateSchool,
  type SchoolListItem,
  type SchoolPlan,
} from '@/lib/superAdminApi';
import { useToast } from '@/components/Toast';

const PLAN_LABELS: Record<SchoolPlan, string> = {
  basic: 'Basic',
  professional: 'Professional',
  enterprise: 'Enterprise',
  trial: 'Trial',
};

const PLAN_BADGE_CLASSES: Record<SchoolPlan, string> = {
  basic: 'bg-gray-100 text-gray-600 border-gray-200',
  professional: 'bg-blue-50 text-blue-700 border-blue-200',
  enterprise: 'bg-purple-50 text-purple-700 border-purple-200',
  trial: 'bg-[#FF761B]/10 text-[#FF761B] border-[#FF761B]/30',
};

const LIMIT = 25;

function formatNaira(value: number | null): string {
  if (value === null) return '—';
  return `₦${Math.round(value).toLocaleString('en-NG')}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function PlanBadge({ plan }: { plan: SchoolPlan | null }) {
  if (!plan) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-gray-100 text-gray-400 border-gray-200">
        No plan
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${PLAN_BADGE_CLASSES[plan]}`}>
      {PLAN_LABELS[plan]}
    </span>
  );
}

function StatusBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-green-50 text-green-700 border-green-200">Active</span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-red-50 text-red-700 border-red-200">Inactive</span>
  );
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

// ── Suspend / Reactivate modals ─────────────────────────────────────────────────

const reasonSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
});

type ReasonForm = z.infer<typeof reasonSchema>;

function SuspendModal({ school, onClose, onDone }: { school: SchoolListItem; onClose: () => void; onDone: () => void }) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ReasonForm>({
    resolver: zodResolver(reasonSchema),
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: ReasonForm) {
    setApiError('');
    try {
      await suspendSchool(school.id, values.reason);
      onDone();
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to suspend school');
    }
  }

  return (
    <Modal title="Suspend School" onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <p className="text-sm text-gray-700">
          This will immediately block all users at <span className="font-medium">{school.name}</span>. Enter a reason:
        </p>
        <Field label="Reason" error={errors.reason?.message}>
          <textarea {...register('reason')} rows={3} className={inputClass} placeholder="Explain why this school is being suspended..." />
        </Field>
        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Suspending…' : 'Suspend'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReactivateModal({ school, onClose, onDone }: { school: SchoolListItem; onClose: () => void; onDone: () => void }) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ReasonForm>({
    resolver: zodResolver(reasonSchema),
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: ReasonForm) {
    setApiError('');
    try {
      await reactivateSchool(school.id, values.reason);
      onDone();
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to reactivate school');
    }
  }

  return (
    <Modal title="Reactivate School" onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <p className="text-sm text-gray-700">
          This will restore access for all users at <span className="font-medium">{school.name}</span>. Enter a reason:
        </p>
        <Field label="Reason" error={errors.reason?.message}>
          <textarea {...register('reason')} rows={3} className={inputClass} placeholder="Explain why this school is being reactivated..." />
        </Field>
        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Reactivating…' : 'Reactivate'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SuperAdminSchoolsPage() {
  const { show } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [schools, setSchools] = useState<SchoolListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'inactive'>('');
  const [plan, setPlan] = useState<'' | SchoolPlan>('');

  const [suspendTarget, setSuspendTarget] = useState<SchoolListItem | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<SchoolListItem | null>(null);

  // Debounce search input
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 400);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getSuperAdminSchools({
      page,
      search: search || undefined,
      status: status || undefined,
      plan: plan || undefined,
    })
      .then((data) => {
        setSchools(data.schools);
        setTotal(data.total);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, search, status, plan]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const rangeStart = total === 0 ? 0 : (page - 1) * LIMIT + 1;
  const rangeEnd = Math.min(total, page * LIMIT);

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">Schools</h1>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search schools..."
          className={`${inputClass} sm:max-w-xs`}
        />
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value as '' | 'active' | 'inactive'); setPage(1); }}
          className={`${inputClass} sm:max-w-[160px]`}
        >
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <select
          value={plan}
          onChange={(e) => { setPlan(e.target.value as '' | SchoolPlan); setPage(1); }}
          className={`${inputClass} sm:max-w-[160px]`}
        >
          <option value="">All Plans</option>
          <option value="basic">Basic</option>
          <option value="professional">Professional</option>
          <option value="enterprise">Enterprise</option>
          <option value="trial">Trial</option>
        </select>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead>
            <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
              <th className="py-3 px-4">School Name</th>
              <th className="py-3 px-4">Plan</th>
              <th className="py-3 px-4">Status</th>
              <th className="py-3 px-4">Students</th>
              <th className="py-3 px-4">MRR</th>
              <th className="py-3 px-4">Next Billing</th>
              <th className="py-3 px-4">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-gray-400">Loading…</td>
              </tr>
            )}
            {!loading && schools.length === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-gray-400">No schools found.</td>
              </tr>
            )}
            {!loading && schools.map((school) => (
              <tr key={school.id}>
                <td className="py-3 px-4">
                  <Link href={`/super-admin/schools/${school.id}`} className="font-semibold text-[#003366] hover:underline">
                    {school.name}
                  </Link>
                </td>
                <td className="py-3 px-4"><PlanBadge plan={school.plan} /></td>
                <td className="py-3 px-4"><StatusBadge isActive={school.is_active} /></td>
                <td className="py-3 px-4 text-gray-700">{school.student_count}</td>
                <td className="py-3 px-4 text-gray-700">{formatNaira(school.amount_naira)}</td>
                <td className="py-3 px-4 text-gray-700">{formatDate(school.next_billing_date)}</td>
                <td className="py-3 px-4">
                  <div className="flex items-center gap-3">
                    <Link href={`/super-admin/schools/${school.id}`} className="text-slate-600 hover:text-slate-900 font-medium">View</Link>
                    {school.is_active ? (
                      <button onClick={() => setSuspendTarget(school)} className="text-red-600 hover:text-red-700 font-medium">Suspend</button>
                    ) : (
                      <button onClick={() => setReactivateTarget(school)} className="text-green-600 hover:text-green-700 font-medium">Reactivate</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-gray-400">Showing {rangeStart}–{rangeEnd} of {total} schools</p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {suspendTarget && (
        <SuspendModal
          school={suspendTarget}
          onClose={() => setSuspendTarget(null)}
          onDone={() => {
            setSuspendTarget(null);
            show('School suspended', 'success');
            load();
          }}
        />
      )}

      {reactivateTarget && (
        <ReactivateModal
          school={reactivateTarget}
          onClose={() => setReactivateTarget(null)}
          onDone={() => {
            setReactivateTarget(null);
            show('School reactivated', 'success');
            load();
          }}
        />
      )}
    </div>
  );
}
