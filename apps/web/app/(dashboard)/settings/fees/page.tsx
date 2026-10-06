'use client';

/**
 * Fee settings: the part-payment minimum, and who pays Paystack's charge on an online payment.
 *
 * The charge (6 Oct 2026): unchosen, the school pays it, as before. "Parents pay it" adds a convenience
 * fee to what a parent pays online, so the school receives its whole fee. Neither option is preselected
 * until the school chooses (doctrine 8), and the example figure comes from the API, which computes it the
 * way the payment does.
 *
 * Parents can pay part of a term's fees online. The school pays the Paystack transaction
 * fee on each attempt (`bearer: 'subaccount'`), so an unbounded floor costs the school
 * money: twenty ₦500 payments against a ₦10,000 balance cost more in fees than one
 * payment would.
 *
 * The default is ₦1,000 and this page says so in as many words. That distinction matters:
 * a default that makes a claim about the SCHOOL'S policy — a pass mark on a report card,
 * say — is wrong even when the number is reasonable, because the school never chose it.
 * A default that is a guardrail on our transaction cost is defensible, provided the school
 * can see whose number it is and change it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

type ConvenienceFeePayer = 'school' | 'parent';

interface FeeConfig {
  min_part_payment: string;
  is_default: boolean;
  /** null: the school has not chosen, and pays. */
  convenience_fee_payer: ConvenienceFeePayer | null;
  convenience_fee_example: { school_fee: string; convenience_fee: string; total: string };
}

function formatCurrency(amount: number | string): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function FeeSettingsPage() {
  const { schoolId } = useAuth();

  const [config, setConfig] = useState<FeeConfig | null>(null);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [payer, setPayer] = useState<ConvenienceFeePayer | null>(null);
  const [savingPayer, setSavingPayer] = useState(false);
  const [payerError, setPayerError] = useState('');
  const [payerSaved, setPayerSaved] = useState(false);

  const load = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    apiFetch<{ success: boolean; data: FeeConfig }>(`/api/schools/${schoolId}/fee-config`)
      .then(({ data }) => { setConfig(data); setValue(data.min_part_payment); setPayer(data.convenience_fee_payer); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load fee settings'))
      .finally(() => setLoading(false));
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId) return;

    const typed = value.trim();
    // Same shape the API accepts, so the rejection happens here rather than after a
    // round trip. The API still validates — this is only to be quicker about it.
    if (!/^\d+(\.\d{1,2})?$/.test(typed) || Number(typed) <= 0) {
      setError('Enter an amount in naira with at most 2 decimal places, e.g. 1000.00');
      return;
    }

    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await apiFetch(`/api/schools/${schoolId}/fee-config`, {
        method: 'PATCH',
        body: JSON.stringify({ min_part_payment: typed }),
      });
      setSaved(true);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save fee settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePayer(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId) return;
    if (!payer) {
      setPayerError('Choose who pays the convenience fee.');
      return;
    }
    setSavingPayer(true);
    setPayerError('');
    setPayerSaved(false);
    try {
      await apiFetch(`/api/schools/${schoolId}/fee-config`, {
        method: 'PATCH',
        body: JSON.stringify({ convenience_fee_payer: payer }),
      });
      setPayerSaved(true);
      load();
    } catch (err) {
      setPayerError(err instanceof Error ? err.message : 'Failed to save fee settings');
    } finally {
      setSavingPayer(false);
    }
  }

  if (!schoolId || loading) {
    return <div className="max-w-2xl mx-auto p-8"><p className="text-sm text-gray-500">Loading…</p></div>;
  }

  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-xl font-semibold text-gray-900 mb-1">Fee Settings</h1>
      <p className="text-sm text-gray-500 mb-6">
        How parents are allowed to pay fees online.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {saved && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Saved. Parents will see the new minimum immediately.
        </div>
      )}

      <form onSubmit={handleSave} className="card p-6 space-y-4">
        <div>
          <label htmlFor="min-part-payment" className="block text-sm font-medium text-gray-900">
            Smallest part payment
          </label>
          <p className="mt-1 text-xs text-gray-500">
            A parent paying only part of a term&apos;s fees must pay at least this much at a time. A parent
            settling the <span className="font-medium text-gray-700">whole remaining balance</span> can always
            do so, even when that balance is smaller than this figure.
          </p>

          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm text-gray-500">₦</span>
            <input
              id="min-part-payment"
              inputMode="decimal"
              value={value}
              onChange={e => { setValue(e.target.value); setError(''); setSaved(false); }}
              className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#003366] focus:outline-none"
            />
          </div>

          {config?.is_default && (
            <p className="mt-2 text-xs text-amber-700">
              {formatCurrency(config.min_part_payment)} is the Chronix default — your school has not set its own
              figure yet. Change it to whatever suits your parents.
            </p>
          )}
        </div>

        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-600">
            When your school pays the payment provider&apos;s charge, a very low minimum means paying that charge
            many times over for the same money. A higher minimum reduces the number of payments — but set it too
            high and a parent who can only pay a little at a time has to come to the school office instead.
          </p>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002347] disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>

      <form onSubmit={handleSavePayer} className="card p-6 space-y-4 mt-6">
        <div>
          <h2 className="text-sm font-medium text-gray-900">Convenience fee for online payments</h2>
          <p className="mt-1 text-xs text-gray-500">
            Our payment provider, Paystack, charges for every online payment. Choose who pays that charge.
          </p>
        </div>

        {payerError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{payerError}</div>
        )}
        {payerSaved && (
          <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            Saved. It applies to every online payment started from now on.
          </div>
        )}

        <fieldset className="space-y-3">
          <legend className="sr-only">Who pays the convenience fee</legend>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="convenience-fee-payer"
              value="school"
              checked={payer === 'school'}
              onChange={() => { setPayer('school'); setPayerError(''); setPayerSaved(false); }}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-gray-900">The school pays it</span>
              <span className="block text-xs text-gray-500">
                Parents pay the school fee and nothing more. The charge comes out of what the school receives.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="convenience-fee-payer"
              value="parent"
              checked={payer === 'parent'}
              onChange={() => { setPayer('parent'); setPayerError(''); setPayerSaved(false); }}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-gray-900">Parents pay it</span>
              <span className="block text-xs text-gray-500">
                A convenience fee is added to what a parent pays online, so the school receives the whole fee.
                {config && (
                  <> On a fee of {formatCurrency(config.convenience_fee_example.school_fee)}, the parent pays{' '}
                  {formatCurrency(config.convenience_fee_example.total)}, including a{' '}
                  {formatCurrency(config.convenience_fee_example.convenience_fee)} convenience fee.</>
                )}{' '}
                Parents see it before they pay, and it is not refundable.
              </span>
            </span>
          </label>
        </fieldset>

        {config && config.convenience_fee_payer === null && (
          <p className="text-xs text-amber-700">
            Not chosen yet. Until your school chooses, the school pays it.
          </p>
        )}

        <button
          type="submit"
          disabled={savingPayer}
          className="px-4 py-2 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002347] disabled:opacity-60"
        >
          {savingPayer ? 'Saving…' : 'Save'}
        </button>
      </form>
    </div>
  );
}
