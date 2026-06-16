'use client';

import { useCallback, useEffect, useState } from 'react';
import { getAuditLogs, type PlatformAuditLog } from '@/lib/superAdminApi';

const LIMIT = 50;

const ACTION_TYPES = [
  'SCHOOL_SUSPENDED',
  'SCHOOL_REACTIVATED',
  'SCHOOL_ONBOARDED',
  'IMPERSONATION_START',
  'IMPERSONATION_END',
  'SUBSCRIPTION_CREATED',
  'MANUAL_PAYMENT_RECORDED',
  'TRIAL_EXPIRED_AUTO_SUSPEND',
  'ANNOUNCEMENT_PUBLISHED',
  'SCHOOL_DATA_WIPED',
] as const;

const ACTION_BADGE: Record<string, string> = {
  SCHOOL_SUSPENDED: 'bg-red-50 text-red-700 border-red-200',
  SCHOOL_REACTIVATED: 'bg-green-50 text-green-700 border-green-200',
  SCHOOL_ONBOARDED: 'bg-blue-50 text-blue-700 border-blue-200',
  IMPERSONATION_START: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  IMPERSONATION_END: 'bg-gray-100 text-gray-600 border-gray-200',
  SUBSCRIPTION_CREATED: 'bg-blue-50 text-blue-700 border-blue-200',
  MANUAL_PAYMENT_RECORDED: 'bg-green-50 text-green-700 border-green-200',
  TRIAL_EXPIRED_AUTO_SUSPEND: 'bg-red-50 text-red-700 border-red-200',
  ANNOUNCEMENT_PUBLISHED: 'bg-blue-50 text-blue-700 border-blue-200',
  SCHOOL_DATA_WIPED: 'bg-red-50 text-red-700 border-red-200',
};

function ActionBadge({ action }: { action: string }) {
  const classes = ACTION_BADGE[action] ?? 'bg-gray-100 text-gray-600 border-gray-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${classes}`}>
      {action}
    </span>
  );
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  return d.toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const inputClass = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';

export default function SuperAdminAuditLogsPage() {
  const [logs, setLogs] = useState<PlatformAuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Pending (form) filter values
  const [actionTypeInput, setActionTypeInput] = useState('');
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');

  // Applied filter values
  const [filters, setFilters] = useState({ action_type: '', from: '', to: '' });

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getAuditLogs({
      page,
      action_type: filters.action_type || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
    })
      .then(setLogs)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  function handleFilter() {
    setPage(1);
    setFilters({ action_type: actionTypeInput, from: fromInput, to: toInput });
  }

  const hasNext = logs.length === LIMIT;

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">Audit Logs</h1>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-4 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Action Type</label>
          <select value={actionTypeInput} onChange={(e) => setActionTypeInput(e.target.value)} className={inputClass}>
            <option value="">All</option>
            {ACTION_TYPES.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
          <input type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
          <input type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} className={inputClass} />
        </div>
        <button
          type="button"
          onClick={handleFilter}
          className="bg-[#003366] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[#002244]"
        >
          Filter
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead>
            <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
              <th className="py-3 px-4">When</th>
              <th className="py-3 px-4">Admin</th>
              <th className="py-3 px-4">Action</th>
              <th className="py-3 px-4">School</th>
              <th className="py-3 px-4">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={5} className="py-10 text-center text-gray-400">Loading…</td>
              </tr>
            )}
            {!loading && logs.length === 0 && (
              <tr>
                <td colSpan={5} className="py-10 text-center text-gray-400">No audit log entries found.</td>
              </tr>
            )}
            {!loading && logs.map((log) => (
              <tr key={log.id} className="align-top">
                <td className="py-3 px-4 text-gray-700 whitespace-nowrap">{formatDateTime(log.created_at)}</td>
                <td className="py-3 px-4 text-gray-700">{log.admin_email}</td>
                <td className="py-3 px-4"><ActionBadge action={log.action_type} /></td>
                <td className="py-3 px-4 text-gray-700">{log.school_name ?? '—'}</td>
                <td className="py-3 px-4">
                  {log.metadata ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                        className="text-slate-600 hover:text-slate-900 font-medium text-xs"
                      >
                        {expandedId === log.id ? 'Hide' : 'Show'}
                      </button>
                      {expandedId === log.id && (
                        <pre className="mt-2 bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-700 whitespace-pre-wrap max-w-md overflow-x-auto">
                          {JSON.stringify(log.metadata, null, 2)}
                        </pre>
                      )}
                    </>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-4">
        <p className="text-sm text-gray-400">Page {page}</p>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasNext}
            className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
