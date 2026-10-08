/**
 * The terms a parent can look back on (Moses, 8 Oct 2026: parents see past terms, "Yes please").
 * A parent saw only the current term, so last term's results, report card, attendance and invoice
 * were out of reach the day the next term began.
 */

import type { SessionLike, TermLike } from './termOrder';

export interface TermChoice {
  id: string;
  label: string;
  isCurrent: boolean;
  name: string;
  start_date: string;
  end_date: string;
}

type TermWithEnd = TermLike & { end_date?: string };

/** Terms that have begun (by Lagos date), newest first, each named with its session. */
export function termsToLookBackOn(sessions: Array<SessionLike<TermWithEnd>>, today: string): TermChoice[] {
  return sessions
    .flatMap(s => (s.terms ?? []).map(t => ({ t, session: s })))
    .filter(({ t }) => t.start_date.slice(0, 10) <= today)
    .sort((a, b) => b.t.start_date.slice(0, 10).localeCompare(a.t.start_date.slice(0, 10)))
    .map(({ t, session }) => ({
      id: t.id,
      label: `${t.name}, ${session.name}${t.is_current && session.is_current ? ' (current)' : ''}`,
      isCurrent: t.is_current && session.is_current,
      name: t.name,
      start_date: t.start_date.slice(0, 10),
      end_date: (t.end_date ?? t.start_date).slice(0, 10),
    }));
}

/** The term to open on: the current one, else the most recent that has begun; null if none has. */
export function defaultTermId(choices: TermChoice[]): string | null {
  return (choices.find(c => c.isCurrent) ?? choices[0])?.id ?? null;
}

/** Today's date in Africa/Lagos, YYYY-MM-DD. */
export function lagosToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
