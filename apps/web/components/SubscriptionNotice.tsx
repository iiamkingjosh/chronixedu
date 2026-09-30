'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * The trial gate, in words (migration 046). A school in grace is told how many days of full
 * access it has left; a read-only school is told that writing is paused, that its records
 * are intact and exportable, and what restores it. Without this a lapsed school sees only a
 * refused save — the difference between a school that renews and one that calls angry.
 *
 * Reads GET /api/schools/:id/subscription-status, which still answers while read-only.
 * Renders nothing for a trial, an active subscription, or when the status cannot be read.
 */
interface GateState {
  state: 'none' | 'active' | 'trial' | 'grace' | 'read_only';
  days_left?: number | null;
  grace_last_day?: string | null;
}

const SUPPORT_EMAIL = 'support@chronixtechnology.com';

export default function SubscriptionNotice({ schoolId, isPrincipal }: { schoolId: string; isPrincipal: boolean }) {
  const [gate, setGate] = useState<GateState | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ success: boolean; data: GateState }>(`/api/schools/${schoolId}/subscription-status`, { deferAuthRedirect: true })
      .then((res) => { if (!cancelled) setGate(res.data); })
      .catch(() => { /* the notice is advisory; a failed read must not break the page */ });
    return () => { cancelled = true; };
  }, [schoolId]);

  if (!gate || (gate.state !== 'grace' && gate.state !== 'read_only')) return null;

  const renew = isPrincipal
    ? <>To renew, contact Chronix at <a className="underline font-medium" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> — full access returns as soon as the payment is recorded.</>
    : <>Please let your principal know.</>;

  if (gate.state === 'grace') {
    const days = gate.days_left ?? 0;
    return (
      <div role="status" className="shrink-0 bg-amber-50 border-b border-amber-200 text-amber-900 text-sm px-4 py-2">
        <strong>Your free trial has ended.</strong>{' '}
        Everything keeps working for {days} more day{days === 1 ? '' : 's'}; after that the school becomes read-only until the subscription is renewed. {renew}
      </div>
    );
  }

  return (
    <div role="alert" className="shrink-0 bg-red-50 border-b border-red-200 text-red-900 text-sm px-4 py-2">
      <strong>This school is read-only.</strong>{' '}
      The trial has ended, so saving changes is paused. Every record is still here and can be viewed{isPrincipal ? <>, and exported from <a className="underline font-medium" href="/settings/export">Settings → Data Export</a></> : null}. {renew}
    </div>
  );
}
