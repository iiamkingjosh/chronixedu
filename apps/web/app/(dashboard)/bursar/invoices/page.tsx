'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import { REFUND_REASON_OPTIONS, type RefundReason } from '@/lib/refundReasons';
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

/** A payment as the invoice view returns it, with what has been refunded against it (kobo, as text). */
interface InvoicePayment extends PaymentRow {
  payment_date: string;
  reference: string | null;
  paystack_reference: string | null;
  refunded_kobo: string;
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
  const [paymentsTarget, setPaymentsTarget] = useState<InvoiceListRow | null>(null);

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
                <td className="px-4 py-3 text-center whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => setPaymentTarget(inv)}
                    disabled={inv.balance <= 0}
                    className="btn-secondary !px-3 !py-1.5 text-xs disabled:opacity-40"
                  >
                    Record Payment
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentsTarget(inv)}
                    disabled={inv.amount_paid <= 0}
                    className="btn-secondary !px-3 !py-1.5 text-xs ml-2 disabled:opacity-40"
                  >
                    Payments
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

      {paymentsTarget && (
        <PaymentsModal
          schoolId={schoolId!}
          termId={termId}
          invoice={paymentsTarget}
          onClose={() => setPaymentsTarget(null)}
          onReceipt={downloadReceipt}
          onRefunded={() => { setRefreshKey((k) => k + 1); show('Refund recorded.'); }}
          onError={(msg) => show(msg, 'error')}
        />
      )}
    </div>
  );
}

const METHOD_LABELS: Record<string, string> = { cash: 'Cash', bank_transfer: 'Bank transfer', paystack: 'Online', waiver: 'Waiver' };

/**
 * An invoice's payments, each with what has been refunded against it. A cash or bank-transfer payment
 * can be refunded here (bursar only). A Paystack payment is refunded in Paystack by Chronix, and the
 * refund appears here by itself when Paystack completes it. A refund never edits the payment.
 */
function PaymentsModal({
  schoolId, termId, invoice, onClose, onReceipt, onRefunded, onError,
}: {
  schoolId: string;
  termId: string;
  invoice: InvoiceListRow;
  onClose: () => void;
  onReceipt: (paymentId: string) => void;
  onRefunded: () => void;
  onError: (msg: string) => void;
}) {
  const [payments, setPayments] = useState<InvoicePayment[] | null>(null);
  const [reload, setReload] = useState(0);
  const [refunding, setRefunding] = useState<InvoicePayment | null>(null);
  // Held in a ref so a new callback from the page does not re-run the fetch: an error shown by the
  // page re-renders it, and a fetch that kept failing would otherwise loop.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ success: boolean; data: { payments: InvoicePayment[] } }>(
      `/api/schools/${schoolId}/fee-invoices/student/${invoice.student_id}?term_id=${encodeURIComponent(termId)}`
    )
      .then((res) => { if (!cancelled) setPayments(res.data.payments); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPayments([]);
        onErrorRef.current(err instanceof Error ? err.message : 'Failed to load payments');
      });
    return () => { cancelled = true; };
  }, [schoolId, termId, invoice.student_id, reload]);

  const refundedNaira = (p: InvoicePayment) => Number(p.refunded_kobo) / 100;

  return (
    <Modal title="Payments" onClose={onClose}>
      <div className="space-y-4">
        <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm">
          <p className="font-medium text-gray-900">{invoice.first_name} {invoice.last_name}</p>
          <p className="text-gray-500">{invoice.admission_no} · {invoice.class_name ?? 'No class'}</p>
        </div>

        {payments === null && <p className="text-sm text-gray-400">Loading…</p>}
        {payments && payments.length === 0 && <p className="text-sm text-gray-500">No payments on this invoice.</p>}
        {payments && payments.length > 0 && (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="py-1">Date</th>
                <th className="py-1">Method</th>
                <th className="py-1 text-right">Amount</th>
                <th className="py-1 text-right">Refunded</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payments.map((p) => {
                const refundable = Number(p.amount) - refundedNaira(p);
                // Any payment that moved money, online ones included: schools refund from their own account.
                const canRefund = p.method !== 'waiver' && refundable > 0;
                return (
                  <tr key={p.id}>
                    <td className="py-2 text-gray-600">{new Date(p.payment_date).toLocaleDateString('en-GB')}</td>
                    <td className="py-2 text-gray-600">{METHOD_LABELS[p.method] ?? p.method}</td>
                    <td className="py-2 text-right text-gray-900">{formatCurrency(Number(p.amount))}</td>
                    <td className="py-2 text-right text-gray-900">{refundedNaira(p) > 0 ? formatCurrency(refundedNaira(p)) : '—'}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button type="button" onClick={() => onReceipt(p.id)} className="text-xs text-blue-600 hover:text-blue-800">Receipt</button>
                      {canRefund && (
                        <button type="button" onClick={() => setRefunding(p)} className="text-xs text-blue-600 hover:text-blue-800 ml-3">Refund</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {payments && payments.length > 0 && (
          <p className="text-xs text-gray-500">
            The school pays a refund back itself, in cash or by bank transfer, online payments included, and records it here.
          </p>
        )}

        {refunding && (
          <RefundForm
            schoolId={schoolId}
            payment={refunding}
            refundable={Number(refunding.amount) - refundedNaira(refunding)}
            onCancel={() => setRefunding(null)}
            onDone={() => { setRefunding(null); setReload((r) => r + 1); onRefunded(); }}
            onError={onError}
          />
        )}
      </div>
    </Modal>
  );
}

function RefundForm({
  schoolId, payment, refundable, onCancel, onDone, onError,
}: {
  schoolId: string;
  payment: InvoicePayment;
  refundable: number;
  onCancel: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [amount, setAmount] = useState(refundable.toFixed(2));
  const [method, setMethod] = useState<'cash' | 'bank_transfer'>(payment.method === 'cash' ? 'cash' : 'bank_transfer');
  const [reason, setReason] = useState<RefundReason | ''>('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ amount?: string; reason?: string; note?: string }>({});

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const typed = amount.trim();
    const errors: { amount?: string; reason?: string; note?: string } = {};
    if (!/^\d+(\.\d{1,2})?$/.test(typed) || Number(typed) <= 0) {
      errors.amount = 'Enter an amount in naira with at most 2 decimal places, e.g. 1500.50';
    }
    if (!reason) errors.reason = 'Choose a reason for the refund';
    if (reason === 'other' && !note.trim()) errors.note = 'Say what the reason is';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/payments/${payment.id}/refunds`, {
        method: 'POST',
        body: JSON.stringify({
          amount: typed, method, reason,
          reference: reference.trim() || undefined,
          note: note.trim() || undefined,
        }),
      });
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to record the refund');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-gray-200 pt-4 space-y-3">
      <p className="text-sm font-medium text-gray-900">Record a refund</p>
      <p className="text-xs text-gray-500">
        Money the school has paid back to the payer. The payment stays as it was; the refund is recorded beside it
        and the invoice balance goes up by the amount. Up to {formatCurrency(refundable)} can be refunded on this
        payment. An online payment&apos;s convenience fee is never refunded.
      </p>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Amount refunded (₦)</label>
        <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="input-field" />
        {fieldErrors.amount && <p className="text-xs text-red-600 mt-1">{fieldErrors.amount}</p>}
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Paid back by</label>
        <select value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'bank_transfer')} className="input-field">
          <option value="cash">Cash</option>
          <option value="bank_transfer">Bank transfer</option>
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Reason</label>
        <select value={reason} onChange={(e) => setReason(e.target.value as RefundReason | '')} className="input-field">
          <option value="">Choose a reason</option>
          {REFUND_REASON_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {fieldErrors.reason && <p className="text-xs text-red-600 mt-1">{fieldErrors.reason}</p>}
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Transfer reference (optional)</label>
        <input type="text" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="If you have one" className="input-field" />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Note{reason === 'other' ? '' : ' (optional)'}</label>
        <input type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. paid twice by mistake" className="input-field" />
        {fieldErrors.note && <p className="text-xs text-red-600 mt-1">{fieldErrors.note}</p>}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-secondary">Cancel</button>
        <button type="submit" disabled={submitting} className="btn-primary">{submitting ? 'Recording…' : 'Record refund'}</button>
      </div>
    </form>
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
    // Send the exact decimal string the bursar typed. It used to go through
    // Number(amount), discarding the precise value this field already holds, and the API
    // then rebuilt a decimal from the float. The API now takes the string and converts
    // once, to integer kobo, so no float exists on either side of the wire.
    const typed = amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(typed) || Number(typed) <= 0) {
      onError('Enter an amount in naira with at most 2 decimal places, e.g. 1500.50');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { payment: PaymentRow } }>(`/api/schools/${schoolId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          invoice_id: invoice.id,
          amount: typed,
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
