/** Types for scripts/audit-gate.js, so the unit test can import it under `strict`. */
export interface AdvisoryRef {
  id: string;
  severity: string;
  package: string;
  title: string;
}

export interface GateContext {
  /** YYYY-MM-DD, injected so expiry is testable. */
  today: string;
  /** apps/web/next.config.js as text, or null when it could not be read. */
  nextConfigText: string | null;
}

export function advisoriesOf(audit: unknown): Map<string, AdvisoryRef>;
export function evaluate(audit: unknown, allowlist: unknown, ctx: GateContext): { failures: string[]; notes: string[] };
export function stripComments(text: string): string;
export const PRECONDITIONS: Record<string, (ctx: GateContext) => string | null>;
