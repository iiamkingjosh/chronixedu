/**
 * Which terms have an assessment structure, for Settings → Assessment Config (audit, 8 Oct 2026).
 * A term without one gives its teachers a score sheet they cannot fill, so the page lists those
 * terms and offers to copy another term's structure into them.
 */

export interface TermOption { id: string; name: string; session_name?: string }

export function termLabel(t: TermOption): string {
  return t.session_name ? `${t.name} (${t.session_name})` : t.name;
}

/** Terms with no structure (in the order given), and the terms a structure can be copied from. */
export function splitTermsByStructure<T extends TermOption>(terms: T[], configs: Array<{ term_id: string }>): { without: T[]; sources: T[] } {
  const withStructure = new Set(configs.map(c => c.term_id));
  return {
    without: terms.filter(t => !withStructure.has(t.id)),
    sources: terms.filter(t => withStructure.has(t.id)),
  };
}
