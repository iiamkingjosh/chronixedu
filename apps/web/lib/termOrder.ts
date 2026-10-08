/**
 * The current term and the one before it, from the sessions list (GET /sessions), for actions that
 * carry a term's set-up into the next one (Settings → Roster's "copy last term's assignments").
 */

export interface TermLike { id: string; name: string; start_date: string; is_current: boolean }
export interface SessionLike<T extends TermLike = TermLike> { id: string; name: string; is_current: boolean; terms?: T[] }

export interface TermPair<T> { current: T; previous: T | null }

/** The current session's current term, and the latest term of any session that starts before it. */
export function currentAndPreviousTerm<T extends TermLike>(sessions: Array<SessionLike<T>>): TermPair<T> | null {
  const session = sessions.find(s => s.is_current);
  const current = session?.terms?.find(t => t.is_current);
  if (!current) return null;
  const start = current.start_date.slice(0, 10);
  const earlier = sessions
    .flatMap(s => s.terms ?? [])
    .filter(t => t.id !== current.id && t.start_date.slice(0, 10) < start)
    .sort((a, b) => b.start_date.slice(0, 10).localeCompare(a.start_date.slice(0, 10)));
  return { current, previous: earlier[0] ?? null };
}
