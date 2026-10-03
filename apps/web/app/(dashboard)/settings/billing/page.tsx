'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/providers';
import { canAccessPlatformBilling, getDefaultDashboardPath } from '@/lib/auth';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PendingPayment {
  reference: string;
  amount_naira: string;
}

interface BillingStatus {
  has_subscription: boolean;
  plan?: string;
  subscription_status?: string;
  billing_cycle?: string;
  amount_naira?: string;
  next_billing_date?: string | null;
  next_billing_basis?: 'next_term' | 'not_yet_known' | 'not_billed' | 'stored' | 'not_set';
  payable?: boolean;
  pending_payment?: PendingPayment | null;
}

function formatCurrency(amount: number | string): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_LABEL: Record<string, string> = {
  trial: 'Free trial',
  grace: 'Trial ended — grace period',
  read_only: 'Trial ended — read-only',
  active: 'Active',
  suspended: 'Suspended',
  cancelled: 'Cancelled',
};

const CYCLE_LABEL: Record<string, string> = {
  termly: 'per term',
  monthly: 'per month',
  annual: 'per year',
};

/** next_billing_date carries no meaning on its own (CLAUDE.md doctrine 8) — it must
 *  always be read together with next_billing_basis. */
function nextBillingText(status: BillingStatus): string {
  switch (status.next_billing_basis) {
    case 'not_billed':
      return 'Nothing is billed during the free trial.';
    case 'not_yet_known':
      return 'Not yet known — add the school’s next term to see a date.';
    case 'next_term':
      return status.next_billing_date ? `At the start of the next term, ${status.next_billing_date}.` : 'Not yet known.';
    case 'not_set':
      return 'Not set.';
    case 'stored':
      return status.next_billing_date ?? 'Not set.';
    default:
      return 'Not set.';
  }
}

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4500);
  };
  return { toast, show };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PlatformBillingPage() {
  const { user, loading: authLoading, schoolId } = useAuth();
  const router = useRouter();
  const allowed = !!user && canAccessPlatformBilling(user.role);
  const { toast, show } = useToast();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(false);

  // Client-side role guard (defence in depth — the API is the real boundary, same
  // requireRole('principal', 'bursar', 'super_admin') as routes/platformBilling.ts).
  useEffect(() => {
    if (!authLoading && user && !canAccessPlatformBilling(user.role)) {
      router.replace(getDefaultDashboardPath(user.role));
    }
  }, [authLoading, user, router]);

  // Paystack redirects the browser back here with ?payment=success|failed|error&reason=...
  // after the callback settles (or fails to). Read it once, then clean the URL — the
  // same pattern parent/fees/page.tsx uses for its own Paystack redirect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');
    if (!payment) return;
    const reason = params.get('reason');
    if (payment === 'success') {
      show('Payment received — thank you.');
    } else if (payment === 'failed') {
      show('The payment was not successful. You have not been charged.', 'error');
    } else {
      show(
        reason === 'amount_mismatch'
          ? 'Something changed between starting and finishing this payment. Contact Chronix before trying again.'
          : reason === 'wrong_currency'
            ? 'This payment was made in a currency other than naira, so it could not be applied. Contact Chronix about a refund.'
            : 'Something went wrong confirming this payment. Contact Chronix if you were charged.',
        'error'
      );
    }
    params.delete('payment');
    params.delete('reason');
    const query = params.toString();
    window.history.replaceState({}, '', query ? `${window.location.pathname}?${query}` : window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadStatus = useCallback(() => {
    if (!schoolId || !allowed) return;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: BillingStatus }>(`/api/schools/${schoolId}/platform-billing/status`)
      .then(res => setStatus(res.data))
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load billing status'))
      .finally(() => setLoading(false));
  }, [schoolId, allowed]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  if (authLoading || !user || !allowed) {
    return null;
  }

  async function handlePayNow() {
    if (!schoolId) return;
    setPaying(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { authorization_url: string } }>(
        `/api/schools/${schoolId}/platform-billing/checkout`,
        { method: 'POST' }
      );
      window.location.href = res.data.authorization_url;
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to start payment', 'error');
      setPaying(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Platform Billing</h1>
        <p className="text-sm text-gray-500">What this school pays Chronix for its own subscription, and paying it online.</p>
      </div>

      {toast && (
        <div className={`rounded-lg px-4 py-3 text-sm ${toast.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {toast.message}
        </div>
      )}

      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {!loading && error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={loadStatus} className="shrink-0 font-medium underline">Retry</button>
        </div>
      )}

      {!loading && !error && status && !status.has_subscription && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          <p className="text-sm text-gray-700">This school has no subscription yet. Contact Chronix.</p>
        </div>
      )}

      {!loading && !error && status?.has_subscription && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Status</span>
            <span className="text-sm font-medium text-gray-900">{STATUS_LABEL[status.subscription_status ?? ''] ?? status.subscription_status}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Plan</span>
            <span className="text-sm font-medium text-gray-900 capitalize">{status.plan}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Current amount due</span>
            <span className="text-lg font-bold text-[#003366]">
              {formatCurrency(status.amount_naira ?? 0)}
              {status.billing_cycle && CYCLE_LABEL[status.billing_cycle] ? ` ${CYCLE_LABEL[status.billing_cycle]}` : ''}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Next billing date</span>
            <span className="text-sm text-gray-700">{nextBillingText(status)}</span>
          </div>

          {status.pending_payment && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
              A payment of {formatCurrency(status.pending_payment.amount_naira)} is in progress. If you already paid, it should confirm shortly —
              otherwise you can start a new one below.
            </div>
          )}

          {status.plan === 'trial' && (
            <p className="text-sm text-gray-500">This school is on a free trial — trial schools are free until the trial ends, so there is nothing to pay yet.</p>
          )}
          {status.subscription_status === 'cancelled' && (
            <p className="text-sm text-gray-500">This subscription is cancelled. Contact Chronix to reinstate it before paying.</p>
          )}

          {status.payable && (
            <button
              type="button"
              onClick={handlePayNow}
              disabled={paying}
              className="w-full rounded-lg bg-[#FF761B] hover:bg-[#e56812] disabled:opacity-60 text-white font-medium py-2.5 text-sm transition-colors"
            >
              {paying ? 'Starting payment…' : 'Pay now'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
