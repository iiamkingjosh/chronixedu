'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import {
  Modal,
  ToastBanner,
  useToast,
  useTermsAndClasses,
  formatCurrency,
  statusBadgeClass,
  STATUS_LABELS,
  type InvoiceStatus,
  type ClassOption,
} from '../shared';

interface InvoiceListRow {
  id: string;
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

interface PaymentRow {
  id: string;
  invoice_id: string;
  amount: number;
  method: string;
}

function classLabel(cls: ClassOption): string {
  return cls.stream ? `${cls.name} (${cls.stream})` : cls.name;
}

export default function InvoicesPage() {
  const { schoolId } = useAuth();
  const { terms, classes, currentTermId, loading: contextLoading, error: contextError } = useTermsAndClasses();
  const { toast, show } = useToast();

  const [termId, setTermId] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | InvoiceStatus>('');
  const [invoices, setInvoices] = useState<InvoiceListRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const [paymentTarget, setPaymentTarget] = useState<InvoiceListRow | null>(null);

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
    if (statusFilter) params.set('status', statusFilter);

    apiFetch<{ success: boolean; data: InvoiceListRow[] }>(`/api/schools/${schoolId}/fee-invoices?${params}`)
      .then((res) => { if (!cancelled) setInvoices(res.data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load invoices'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [schoolId, termId, classFilter, statusFilter, refreshKey]);

  async function downloadReceipt(paymentId: string) {
    try {
      const res = await apiFetch<{ success: boolean; data: { url: string } }>(`/api/schools/${schoolId}/payments/${paymentId}/receipt`);
      window.open(res.data.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to generate receipt', 'error');
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-8">
      <ToastBanner toast={toast} />

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Invoices</h1>
        <p className="text-sm text-gray-500 mt-1">View student fee invoices and record payments.</p>
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

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | InvoiceStatus)}
            className="input-field"
          >
            <option value="">All statuses</option>
            <option value="unpaid">{STATUS_LABELS.unpaid}</option>
            <option value="partial">{STATUS_LABELS.partial}</option>
            <option value="paid">{STATUS_LABELS.paid}</option>
          </select>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

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
              <th className="px-4 py-3 text-center font-medium text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
            )}
            {!loading && invoices.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-400">No invoices found for the selected filters.</td></tr>
            )}
            {!loading && invoices.map((inv) => (
              <tr key={inv.id} className="table-row-hover">
                <td className="px-4 py-3 font-medium text-gray-900">{inv.first_name} {inv.last_name}</td>
                <td className="px-4 py-3 text-gray-600">{inv.admission_no}</td>
                <td className="px-4 py-3 text-gray-600">{inv.class_name ?? '—'}</td>
                <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(inv.total_amount)}</td>
                <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(inv.amount_paid)}</td>
                <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(inv.balance)}</td>
                <td className="px-4 py-3 text-center">
                  <span className={statusBadgeClass(inv.status)}>{STATUS_LABELS[inv.status]}</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <button
                    type="button"
                    onClick={() => setPaymentTarget(inv)}
                    disabled={inv.balance <= 0}
                    className="btn-secondary !px-3 !py-1.5 text-xs disabled:opacity-40"
                  >
                    Record Payment
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {paymentTarget && (
        <RecordPaymentModal
          schoolId={schoolId!}
          invoice={paymentTarget}
          onClose={() => setPaymentTarget(null)}
          onSuccess={async (payment) => {
            setPaymentTarget(null);
            setRefreshKey((k) => k + 1);
            show('Payment recorded. Generating receipt…');
            await downloadReceipt(payment.id);
          }}
          onError={(msg) => show(msg, 'error')}
        />
      )}
    </div>
  );
}

function RecordPaymentModal({
  schoolId,
  invoice,
  onClose,
  onSuccess,
  onError,
}: {
  schoolId: string;
  invoice: InvoiceListRow;
  onClose: () => void;
  onSuccess: (payment: PaymentRow) => void;
  onError: (msg: string) => void;
}) {
  const [amount, setAmount] = useState(String(invoice.balance));
  const [method, setMethod] = useState<'cash' | 'bank_transfer' | 'waiver'>('cash');
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) return;

    setSubmitting(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { payment: PaymentRow } }>(`/api/schools/${schoolId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          invoice_id: invoice.id,
          amount: numericAmount,
          method,
          reference: reference.trim() || null,
        }),
      });
      onSuccess(res.data.payment);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to record payment');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Record Payment" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm">
          <p className="font-medium text-gray-900">{invoice.first_name} {invoice.last_name}</p>
          <p className="text-gray-500">{invoice.admission_no} · {invoice.class_name ?? 'No class'}</p>
          <p className="text-gray-500 mt-1">Outstanding balance: <span className="font-medium text-gray-900">{formatCurrency(invoice.balance)}</span></p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Amount (₦)</label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            max={invoice.balance}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className="input-field"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Payment Method</label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as 'cash' | 'bank_transfer' | 'waiver')}
            className="input-field"
          >
            <option value="cash">Cash</option>
            <option value="bank_transfer">Bank Transfer</option>
            <option value="waiver">Waiver</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Reference (optional)</label>
          <input
            type="text"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. teller number, transaction ID"
            className="input-field"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Recording…' : 'Record Payment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
