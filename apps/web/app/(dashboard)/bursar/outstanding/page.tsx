'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import {
  ToastBanner,
  useToast,
  useTermsAndClasses,
  formatCurrency,
  statusBadgeClass,
  STATUS_LABELS,
  type InvoiceStatus,
  type ClassOption,
} from '../shared';

interface OutstandingBalanceRow {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  class_name: string | null;
  total_amount: number;
  amount_paid: number;
  balance: number;
  status: InvoiceStatus;
}

function classLabel(cls: ClassOption): string {
  return cls.stream ? `${cls.name} (${cls.stream})` : cls.name;
}

function toCsvCell(value: string | number): string {
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default function OutstandingBalancesPage() {
  const { schoolId } = useAuth();
  const { terms, classes, currentTermId, loading: contextLoading, error: contextError } = useTermsAndClasses();
  const { toast, show } = useToast();

  const [termId, setTermId] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [rows, setRows] = useState<OutstandingBalanceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sendingReminders, setSendingReminders] = useState(false);

  useEffect(() => {
    if (!termId && currentTermId) setTermId(currentTermId);
  }, [currentTermId, termId]);

  useEffect(() => {
    if (!schoolId || !termId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    const params = new URLSearchParams({ term_id: termId });
    if (classFilter) params.set('class_id', classFilter);

    apiFetch<{ success: boolean; data: OutstandingBalanceRow[] }>(`/api/schools/${schoolId}/fee-invoices/outstanding?${params}`)
      .then((res) => { if (!cancelled) setRows(res.data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load outstanding balances'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [schoolId, termId, classFilter]);

  const totalOutstanding = rows.reduce((sum, r) => sum + Number(r.balance), 0);

  async function sendReminders() {
    if (!schoolId) return;
    setSendingReminders(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { reminders_sent: number } }>(
        `/api/schools/${schoolId}/fee-reminders/run`,
        { method: 'POST' }
      );
      show(`Fee reminders sent to ${res.data.reminders_sent} parent${res.data.reminders_sent === 1 ? '' : 's'}.`);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to send fee reminders', 'error');
    } finally {
      setSendingReminders(false);
    }
  }

  function exportCsv() {
    if (rows.length === 0) {
      show('No outstanding balances to export.', 'error');
      return;
    }

    const term = terms.find((t) => t.id === termId);
    const header = ['Student', 'Admission No', 'Class', 'Total Amount', 'Amount Paid', 'Balance', 'Status'];
    const lines = [header.map(toCsvCell).join(',')];

    for (const r of rows) {
      lines.push([
        `${r.first_name} ${r.last_name}`,
        r.admission_no,
        r.class_name ?? '',
        Number(r.total_amount).toFixed(2),
        Number(r.amount_paid).toFixed(2),
        Number(r.balance).toFixed(2),
        STATUS_LABELS[r.status],
      ].map(toCsvCell).join(','));
    }

    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const filenameTerm = term ? `${term.sessionName}-${term.name}`.replace(/\s+/g, '-').toLowerCase() : 'term';
    link.href = url;
    link.download = `outstanding-balances-${filenameTerm}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-5xl mx-auto p-8">
      <ToastBanner toast={toast} />

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Outstanding Balances</h1>
          <p className="text-sm text-gray-500 mt-1">Students with unpaid or partially paid invoices.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={sendReminders}
            disabled={sendingReminders}
            className="btn-secondary"
          >
            {sendingReminders ? 'Sending…' : 'Send Fee Reminders'}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={loading || rows.length === 0}
            className="btn-primary"
          >
            Export CSV
          </button>
        </div>
      </div>

      {contextError && <p className="text-sm text-red-600 mb-4">{contextError}</p>}

      <div className="flex flex-wrap gap-4 mb-6">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Term</label>
          <select
            value={termId}
            onChange={(e) => setTermId(e.target.value)}
            disabled={contextLoading}
            className="input-field"
          >
            {terms.length === 0 && <option value="">No terms available</option>}
            {terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.sessionName} — {t.name}{t.isCurrent ? ' (Current)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Class</label>
          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            disabled={contextLoading}
            className="input-field"
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{classLabel(c)}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      {!loading && rows.length > 0 && (
        <div className="mb-4 text-sm text-gray-600">
          {rows.length} student{rows.length === 1 ? '' : 's'} with outstanding balances · Total outstanding: <span className="font-semibold text-gray-900">{formatCurrency(totalOutstanding)}</span>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Student</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Admission No</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Class</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Total</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Paid</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Balance</th>
              <th className="px-4 py-3 text-center font-medium text-gray-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No outstanding balances for the selected filters.</td></tr>
            )}
            {!loading && rows.map((r) => (
              <tr key={r.student_id} className="table-row-hover">
                <td className="px-4 py-3 font-medium text-gray-900">{r.first_name} {r.last_name}</td>
                <td className="px-4 py-3 text-gray-600">{r.admission_no}</td>
                <td className="px-4 py-3 text-gray-600">{r.class_name ?? '—'}</td>
                <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(r.total_amount)}</td>
                <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(r.amount_paid)}</td>
                <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(r.balance)}</td>
                <td className="px-4 py-3 text-center">
                  <span className={statusBadgeClass(r.status)}>{STATUS_LABELS[r.status]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
