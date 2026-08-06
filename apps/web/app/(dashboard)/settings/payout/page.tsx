'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Bank {
  name: string;
  code: string;
}

interface PayoutStatus {
  settlement_status: 'pending' | 'active' | 'failed';
  bank_code?: string;
  account_number?: string;
  account_name?: string;
  failure_reason?: string;
}

const schema = z.object({
  bank_code: z.string().min(1, 'Select a bank'),
  account_number: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
});

type FormValues = z.infer<typeof schema>;

// ── Toast helper ──────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };
  return { toast, show };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PayoutSettingsPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<PayoutStatus | null>(null);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [changingAccount, setChangingAccount] = useState(false);

  const { register, handleSubmit, watch, reset, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { bank_code: '', account_number: '' },
  });

  const loadStatus = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    Promise.all([
      apiFetch<{ success: boolean; data: PayoutStatus }>(`/api/schools/${schoolId}/settings/payout`),
      apiFetch<{ success: boolean; data: Bank[] }>(`/api/schools/${schoolId}/settings/payout/banks`),
    ])
      .then(([statusRes, banksRes]) => {
        setStatus(statusRes.data);
        setBanks(banksRes.data);
      })
      .catch(err => show(err instanceof Error ? err.message : 'Failed to load payout settings', 'error'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  async function handleResolve(values: FormValues) {
    if (!schoolId) return;
    setResolveError('');
    setResolvedName(null);
    setResolving(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { account_name: string } }>(
        `/api/schools/${schoolId}/settings/payout/resolve`,
        { method: 'POST', body: JSON.stringify(values) }
      );
      setResolvedName(res.data.account_name);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Couldn't verify this account — check the details and try again.");
    } finally {
      setResolving(false);
    }
  }

  async function handleConfirm() {
    if (!schoolId || !resolvedName) return;
    const values = watch();
    setSaving(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/settings/payout`, {
        method: 'PUT',
        body: JSON.stringify({ ...values, account_name: resolvedName }),
      });
      show('Payout account saved');
      setResolvedName(null);
      setChangingAccount(false);
      reset();
      loadStatus();
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to save payout account', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="max-w-xl mx-auto p-4"><p className="text-sm text-gray-500">Loading…</p></div>;
  }

  const showForm = !status || status.settlement_status !== 'active' || changingAccount;

  return (
    <div className="max-w-xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Payout Setup</h1>
        <p className="text-sm text-gray-500">Fees paid by parents settle directly to this bank account. Chronix never touches this money.</p>
      </div>

      {toast && (
        <div className={`rounded-lg px-4 py-3 text-sm ${toast.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {toast.message}
        </div>
      )}

      {status?.settlement_status === 'active' && !changingAccount && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-3">
          <p className="text-sm text-green-700 font-medium">Payout is active.</p>
          <p className="text-sm text-gray-700">{status.account_name} — {status.account_number}</p>
          <button
            type="button"
            onClick={() => setChangingAccount(true)}
            className="text-sm font-medium text-[#2472B4] hover:underline"
          >
            Change bank account
          </button>
        </div>
      )}

      {status?.settlement_status === 'failed' && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          Last attempt failed: {status.failure_reason ?? 'Unknown error'}. Try again below.
        </div>
      )}

      {showForm && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          {!resolvedName ? (
            <form onSubmit={handleSubmit(handleResolve)} className="space-y-4">
              <div>
                <label htmlFor="bank_code" className="block text-sm font-medium text-gray-700 mb-1.5">Bank</label>
                <select
                  id="bank_code"
                  {...register('bank_code')}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
                >
                  <option value="">Select a bank</option>
                  {banks.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
                </select>
                {errors.bank_code && <p className="mt-1 text-xs text-red-600">{errors.bank_code.message}</p>}
              </div>
              <div>
                <label htmlFor="account_number" className="block text-sm font-medium text-gray-700 mb-1.5">Account Number</label>
                <input
                  id="account_number"
                  {...register('account_number')}
                  maxLength={10}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
                  placeholder="0123456789"
                />
                {errors.account_number && <p className="mt-1 text-xs text-red-600">{errors.account_number.message}</p>}
              </div>
              {resolveError && <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{resolveError}</div>}
              <button
                type="submit"
                disabled={resolving}
                className="w-full rounded-lg bg-[#FF761B] hover:bg-[#e56812] disabled:opacity-60 text-white font-medium py-2.5 text-sm transition-colors"
              >
                {resolving ? 'Verifying…' : 'Verify Account'}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">Is this your school&apos;s account?</p>
              <p className="text-lg font-semibold text-gray-900">{resolvedName}</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={saving}
                  className="flex-1 rounded-lg bg-[#FF761B] hover:bg-[#e56812] disabled:opacity-60 text-white font-medium py-2.5 text-sm transition-colors"
                >
                  {saving ? 'Saving…' : 'Confirm & Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setResolvedName(null)}
                  className="flex-1 rounded-lg border border-gray-300 text-gray-700 font-medium py-2.5 text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
