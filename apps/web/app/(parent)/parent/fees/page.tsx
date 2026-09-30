'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { useParentContext } from '@/lib/parentContext';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaymentRow {
  id: string;
  amount: number;
  payment_date: string;
  method: string;
}

interface InvoiceData {
  id: string;
  total_amount: number;
  amount_paid: number;
  balance: number;
  status: 'unpaid' | 'partial' | 'paid';
  payments: PaymentRow[];
  /** Smallest part payment the school accepts online, as a 2-dp naira string. */
  min_part_payment: string;
}

const STATUS_LABELS: Record<InvoiceData['status'], string> = {
  unpaid: 'Unpaid',
  partial: 'Partially Paid',
  paid: 'Paid',
};

const STATUS_STYLES: Record<InvoiceData['status'], string> = {
  unpaid: 'bg-red-50 text-red-700 border-red-200',
  partial: 'bg-amber-50 text-amber-700 border-amber-200',
  paid: 'bg-green-50 text-green-700 border-green-200',
};

function formatCurrency(amount: number | string): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Naira with at most 2 decimal places — the same shape the API's nairaToKobo accepts. */
function isValidAmount(value: string): boolean {
  const v = value.trim();
  return /^\d+(\.\d{1,2})?$/.test(v) && Number(v) > 0;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ParentFeesPage() {
  const { schoolId } = useAuth();
  const { selectedChild, loading: childrenLoading, error: childrenError, children: linkedChildren } = useParentContext();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState('');
  // Presets rather than a bare number field: it cuts typos and ₦1 test payments, and it
  // lets the part-payment rule be stated before the parent types rather than after.
  const [payMode, setPayMode] = useState<'full' | 'part'>('full');
  const [partAmount, setPartAmount] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('payment');
    if (status) {
      setPaymentStatus(status);
      params.delete('payment');
      params.delete('reason');
      const query = params.toString();
      window.history.replaceState({}, '', query ? `${window.location.pathname}?${query}` : window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!schoolId || !selectedChild) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setInvoice(null);

    apiFetch<{ success: boolean; data: { term: { id: string } | null } }>(`/api/schools/${schoolId}/current-context`)
      .then(({ data }) => {
        if (cancelled) return;
        const termId = data.term?.id;
        if (!termId) {
          setError('No active term has been set up yet.');
          return null;
        }
        return apiFetch<{ success: boolean; data: InvoiceData }>(
          `/api/schools/${schoolId}/fee-invoices/student/${selectedChild.student_id}?term_id=${termId}`
        );
      })
      .then(res => {
        if (cancelled || !res) return;
        setInvoice(res.data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load fee invoice';
        if (message.includes('No invoice found')) {
          setInvoice(null);
        } else {
          setError(message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId, selectedChild]);

  async function handlePayNow() {
    if (!schoolId || !invoice) return;

    // Omitting amount means "the whole balance", which is also what lets a parent settle
    // a balance smaller than the minimum — the server allows any payment that clears it.
    let amount: string | undefined;
    if (payMode === 'part') {
      const typed = partAmount.trim();
      if (!isValidAmount(typed)) {
        setPayError('Enter an amount in naira, with at most 2 decimal places.');
        return;
      }
      if (Number(typed) > Number(invoice.balance)) {
        setPayError(`That is more than the ${formatCurrency(invoice.balance)} still owed.`);
        return;
      }
      if (Number(typed) < Number(invoice.min_part_payment) && Number(typed) < Number(invoice.balance)) {
        setPayError(`Part payments start at ${formatCurrency(invoice.min_part_payment)}. You can also pay the full balance.`);
        return;
      }
      amount = typed;
    }

    setPaying(true);
    setPayError('');
    try {
      const res = await apiFetch<{ success: boolean; data: { authorization_url: string } }>(
        `/api/schools/${schoolId}/payments/paystack/initiate`,
        {
          method: 'POST',
          body: JSON.stringify(amount === undefined ? { invoice_id: invoice.id } : { invoice_id: invoice.id, amount }),
        }
      );
      window.location.href = res.data.authorization_url;
    } catch (err) {
      setPayError(err instanceof Error ? err.message : 'Failed to start payment');
      setPaying(false);
    }
  }

  async function downloadReceipt(paymentId: string) {
    if (!schoolId) return;
    setReceiptError('');
    try {
      const res = await apiFetch<{ success: boolean; data: { url: string } }>(
        `/api/schools/${schoolId}/payments/${paymentId}/receipt`
      );
      window.open(res.data.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setReceiptError(err instanceof Error ? err.message : 'Failed to generate receipt');
    }
  }

  if (childrenLoading) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  if (childrenError) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{childrenError}</div>
      </div>
    );
  }

  if (linkedChildren.length === 0 || !selectedChild) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          No students are linked to your account yet. Please contact your school&apos;s administration.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Fees</h1>
        <p className="text-sm text-gray-500">
          {selectedChild.first_name} {selectedChild.last_name} · {selectedChild.class_name ?? 'No class assigned'}
        </p>
      </div>

      {paymentStatus === 'success' && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700">
          Payment successful. Thank you!
        </div>
      )}
      {paymentStatus === 'failed' && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          Your payment was not successful. Please try again.
        </div>
      )}
      {paymentStatus === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          Something went wrong while confirming your payment. Please contact your school if you were charged.
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading…</p>
      ) : !invoice ? (
        !error && (
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 text-center">
            <p className="text-sm text-gray-500">No fee invoice has been generated for this term yet.</p>
          </div>
        )
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-900">This Term&apos;s Invoice</h2>
              <span className={`text-xs font-medium px-2 py-1 rounded-full border ${STATUS_STYLES[invoice.status]}`}>
                {STATUS_LABELS[invoice.status]}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center mb-4">
              <div>
                <p className="text-lg font-bold text-[#003366]">{formatCurrency(invoice.total_amount)}</p>
                <p className="text-xs text-gray-500 mt-1">Total</p>
              </div>
              <div>
                <p className="text-lg font-bold text-green-600">{formatCurrency(invoice.amount_paid)}</p>
                <p className="text-xs text-gray-500 mt-1">Paid</p>
              </div>
              <div>
                <p className="text-lg font-bold text-red-600">{formatCurrency(invoice.balance)}</p>
                <p className="text-xs text-gray-500 mt-1">Balance</p>
              </div>
            </div>

            {payError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-3">{payError}</div>
            )}

            {Number(invoice.balance) > 0 ? (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setPayMode('full'); setPayError(''); }}
                    className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border ${
                      payMode === 'full'
                        ? 'bg-[#003366] text-white border-[#003366]'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    Pay in full
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPayMode('part'); setPayError(''); }}
                    className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border ${
                      payMode === 'part'
                        ? 'bg-[#003366] text-white border-[#003366]'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    Pay part
                  </button>
                </div>

                {payMode === 'part' && (
                  <div>
                    <label htmlFor="part-amount" className="block text-xs font-medium text-gray-600 mb-1">
                      Amount to pay now
                    </label>
                    <input
                      id="part-amount"
                      inputMode="decimal"
                      value={partAmount}
                      onChange={e => { setPartAmount(e.target.value); setPayError(''); }}
                      placeholder={invoice.min_part_payment}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#003366] focus:outline-none"
                    />
                    {/* The rule, stated before they type rather than surfaced as an error
                        after. The route enforces it either way; this is so a parent is
                        not surprised by a refusal. */}
                    <p className="mt-1 text-xs text-gray-500">
                      Part payments start at {formatCurrency(invoice.min_part_payment)}. You can pay any amount
                      from there up to the {formatCurrency(invoice.balance)} still owed — or pay the balance in
                      full, whatever its size.
                    </p>
                    {isValidAmount(partAmount) && Number(partAmount) <= Number(invoice.balance) && (
                      /* What they will still owe, shown BEFORE they commit rather than in
                         the receipt email afterwards. */
                      <p className="mt-1.5 text-xs font-medium text-gray-700">
                        {Number(partAmount) === Number(invoice.balance)
                          ? 'This clears the balance in full.'
                          : `After this payment you will still owe ${formatCurrency(Number(invoice.balance) - Number(partAmount))}.`}
                      </p>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handlePayNow}
                  disabled={paying}
                  className="w-full px-4 py-2.5 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002347] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {paying
                    ? 'Redirecting to Paystack…'
                    : payMode === 'full'
                      ? `Pay Now (${formatCurrency(invoice.balance)})`
                      : `Pay Now${partAmount.trim() ? ` (${formatCurrency(partAmount)})` : ''}`}
                </button>
              </div>
            ) : (
              <p className="text-sm text-green-600 text-center font-medium">This invoice has been fully paid.</p>
            )}
          </div>

          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Payment History</h2>
            {receiptError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-sm text-red-700 mb-3">{receiptError}</div>
            )}
            {invoice.payments.length === 0 ? (
              <p className="text-sm text-gray-500">No payments have been recorded yet.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {invoice.payments.map(p => (
                  <div key={p.id} className="flex items-center justify-between py-2 text-sm">
                    <div>
                      <p className="text-gray-900 font-medium">{formatCurrency(p.amount)}</p>
                      <p className="text-xs text-gray-500">
                        {new Date(p.payment_date).toLocaleDateString()} · {p.method.replace('_', ' ')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => downloadReceipt(p.id)}
                      className="text-xs font-medium text-[#2472B4] hover:underline"
                    >
                      Download Receipt
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
