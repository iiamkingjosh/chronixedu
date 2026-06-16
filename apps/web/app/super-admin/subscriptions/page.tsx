'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts';
import {
  getSubscriptions,
  getMRR,
  type SubscriptionListItem,
  type MRRResponse,
  type SchoolPlan,
  type SubscriptionStatus,
} from '@/lib/superAdminApi';

const LIMIT = 25;

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

const SUB_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  cancelled: 'Cancelled',
  trial: 'Trial',
};

const SUB_STATUS_BADGE: Record<SubscriptionStatus, string> = {
  active: 'bg-green-50 text-green-700 border-green-200',
  suspended: 'bg-red-50 text-red-700 border-red-200',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-200',
  trial: 'bg-[#FF761B]/10 text-[#FF761B] border-[#FF761B]/30',
};

function formatNaira(value: number): string {
  return `₦${Math.round(value).toLocaleString('en-NG')}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function PlanBadge({ plan }: { plan: SchoolPlan }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${PLAN_BADGE_CLASSES[plan]}`}>
      {PLAN_LABELS[plan]}
    </span>
  );
}

function SubStatusBadge({ status }: { status: SubscriptionStatus }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${SUB_STATUS_BADGE[status]}`}>
      {SUB_STATUS_LABELS[status]}
    </span>
  );
}

export default function SuperAdminSubscriptionsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionListItem[]>([]);
  const [summary, setSummary] = useState<{ total_mrr_naira: number; active_count: number; trial_count: number } | null>(null);
  const [mrr, setMrr] = useState<MRRResponse | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([getSubscriptions({ page }), getMRR()])
      .then(([subsData, mrrData]) => {
        setSubscriptions(subsData.subscriptions);
        setSummary(subsData.summary);
        setTotal(subsData.total);
        setMrr(mrrData);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const rangeStart = total === 0 ? 0 : (page - 1) * LIMIT + 1;
  const rangeEnd = Math.min(total, page * LIMIT);

  const chartData = (mrr?.by_plan ?? []).map((p) => ({
    plan: PLAN_LABELS[p.plan as SchoolPlan] ?? p.plan,
    mrr: p.mrr,
  }));

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">Subscriptions</h1>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {!loading && summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-lg shadow-sm p-5">
            <p className="text-2xl font-bold text-[#003366]">{formatNaira(summary.total_mrr_naira)}</p>
            <p className="text-sm text-gray-500 mt-1">Total MRR</p>
          </div>
          <div className="bg-white rounded-lg shadow-sm p-5">
            <p className="text-2xl font-bold text-[#003366]">{summary.active_count}</p>
            <p className="text-sm text-gray-500 mt-1">Active Schools</p>
          </div>
          <div className="bg-white rounded-lg shadow-sm p-5">
            <p className="text-2xl font-bold text-[#003366]">{summary.trial_count}</p>
            <p className="text-sm text-gray-500 mt-1">Trial Schools</p>
          </div>
        </div>
      )}

      {!loading && chartData.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm p-5 mb-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">MRR by Plan</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="plan" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={(value: number) => `₦${value.toLocaleString('en-NG')}`} />
              <Tooltip formatter={(value) => formatNaira(Number(value))} />
              <Bar dataKey="mrr" fill="#003366" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead>
            <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
              <th className="py-3 px-4">School</th>
              <th className="py-3 px-4">Plan</th>
              <th className="py-3 px-4">Status</th>
              <th className="py-3 px-4">Amount</th>
              <th className="py-3 px-4">Billing</th>
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
            {!loading && subscriptions.length === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-gray-400">No subscriptions found.</td>
              </tr>
            )}
            {!loading && subscriptions.map((sub) => (
              <tr key={sub.id}>
                <td className="py-3 px-4 font-semibold text-gray-900">{sub.school_name}</td>
                <td className="py-3 px-4"><PlanBadge plan={sub.plan} /></td>
                <td className="py-3 px-4"><SubStatusBadge status={sub.subscription_status} /></td>
                <td className="py-3 px-4 text-gray-700">{formatNaira(sub.amount_naira)}</td>
                <td className="py-3 px-4 text-gray-700 capitalize">{sub.billing_cycle}</td>
                <td className="py-3 px-4 text-gray-700">{formatDate(sub.next_billing_date)}</td>
                <td className="py-3 px-4">
                  <Link href={`/super-admin/schools/${sub.school_id}?tab=subscription`} className="text-slate-600 hover:text-slate-900 font-medium">
                    Manage
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-gray-400">Showing {rangeStart}–{rangeEnd} of {total} subscriptions</p>
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
    </div>
  );
}
