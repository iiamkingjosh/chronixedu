/**
 * Money conversion. Doctrine 7: arithmetic happens in integer kobo, never in naira
 * floats.
 *
 * These live in their own module rather than in `db/queries/fees` for a reason worth
 * recording: they are pure functions with no database access, and route tests that
 * `jest.mock('../db/queries/fees')` were silently auto-mocking them to `undefined` — so
 * a route reading a balance got `NaN` and the test reported a confusing diff rather than
 * the real cause. A helper reachable from a route has no business living behind a mock
 * boundary meant for queries.
 */

/**
 * A naira amount — a `numeric(12,2)` string from pg, or a number — as integer kobo.
 *
 * `toFixed(6)` before rounding because the multiply happens in float and can land just
 * under the .5 boundary: `1.005 * 100` is `100.49999999999999`, which `Math.round` sends
 * DOWN to 100, losing half a kobo. Rounding the decimal value rather than its float
 * shadow gives 101.
 *
 * Note this rounds rather than rejects. Routes reject sub-kobo input at their boundary
 * (see `nairaToKobo` in routes/fees.ts) so a bursary is never told one figure while the
 * receipt records another; this is the belt behind that brace, not the decision.
 */
export function toKobo(amount: number | string): number {
  return Math.round(Number((Number(amount) * 100).toFixed(6)));
}

/** Back to the 2-dp string the `numeric(12,2)` columns take. */
export function fromKobo(kobo: number): string {
  return (kobo / 100).toFixed(2);
}
