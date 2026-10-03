'use client';

import { useCallback, useEffect, useState } from 'react';
import { getPricing, setPricing, previewPricing, type PricingResponse } from '@/lib/superAdminApi';
import { nairaToKobo, formatKobo } from '@/lib/money';
import { pricingConfirmMessage } from '@/lib/pricingConfirm';
import { useToast } from '@/components/Toast';

/**
 * The per-student rate (3 Oct 2026). Every paid subscription is priced from it, and until it is set
 * none can be created. Shown to every platform admin; changed only by the root admin, which the API
 * enforces whatever this panel shows. Saving reprices every paid subscription at once.
 */
export default function PricingPanel() {
  const { show } = useToast();
  const [pricing, setPricingState] = useState<PricingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    getPricing().then(setPricingState).catch((err: Error) => setError(err.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!pricing) return;
    const kobo = nairaToKobo(input);
    if (kobo === null) {
      setInputError('Enter an amount in naira, such as 800 or 800.50.');
      return;
    }
    if (kobo > pricing.max_price_per_student_kobo) {
      setInputError(`That is more than ${formatKobo(pricing.max_price_per_student_kobo)} per student. Check it is in naira, not kobo.`);
      return;
    }
    setInputError(null);
    setSaving(true);
    try {
      // The bill, not just the rate: a slip (80 for 800) shows in the totals, which the ceiling cannot catch.
      const preview = await previewPricing(kobo);
      if (!window.confirm(pricingConfirmMessage(pricing.price_per_student_kobo, kobo, preview.subscriptions))) return;
      const res = await setPricing(kobo);
      show(`Rate set to ${formatKobo(res.price_per_student_kobo)} per student. ${res.subscriptions_repriced} paid subscription${res.subscriptions_repriced === 1 ? '' : 's'} repriced.`, 'success');
      setInput('');
      load();
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to set the rate', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-5 mb-6">
      <h2 className="text-base font-semibold text-gray-900">Per-student rate</h2>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {!error && !pricing && <div className="mt-3 h-5 w-48 bg-gray-100 rounded animate-pulse" />}
      {pricing && (
        <>
          {pricing.price_per_student_kobo === null ? (
            <p className="mt-2 text-sm text-amber-700">
              Not set. No paid subscription can be created or changed until it is.
            </p>
          ) : (
            <p className="mt-2 text-sm text-gray-700">
              <span className="text-xl font-bold text-[#003366]">{formatKobo(pricing.price_per_student_kobo)}</span>{' '}
              per enrolled student, per term.
              {pricing.last_set && (
                <span className="block text-xs text-gray-500 mt-1">
                  Last set by {pricing.last_set.by} on {new Date(pricing.last_set.at).toLocaleString('en-NG')}.
                </span>
              )}
            </p>
          )}
          {pricing.outside_change && (
            <p className="mt-2 text-xs text-amber-700">
              {pricing.outside_change.kind === 'removed'
                ? 'The rate was removed outside Chronix Edu, after the last change recorded here. Nothing records who removed it.'
                : `The stored rate was set or changed outside Chronix Edu${pricing.outside_change.at ? ` (${new Date(pricing.outside_change.at).toLocaleString('en-NG')})` : ''}, after the last change recorded here. Nothing records who changed it.`}
            </p>
          )}
          {pricing.can_edit ? (
            <div className="mt-4 flex flex-wrap items-start gap-3">
              <div>
                <label htmlFor="rate" className="block text-sm font-medium text-gray-700 mb-1">New rate (₦ per student)</label>
                <input
                  id="rate"
                  inputMode="decimal"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder="800"
                  className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
                />
                {inputError && <p className="mt-1 text-xs text-red-600 max-w-xs">{inputError}</p>}
              </div>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="mt-6 px-4 py-2 rounded-lg bg-[#003366] text-white text-sm font-medium hover:bg-[#002244] disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Set rate'}
              </button>
            </div>
          ) : (
            <p className="mt-3 text-xs text-gray-500">Only the root admin can change the rate.</p>
          )}
        </>
      )}
    </div>
  );
}
