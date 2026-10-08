'use client';

import type { TermChoice } from '@/lib/parentTerms';

/** A term picker for screens that can look back at earlier terms; shows nothing with one term to choose. */
export function TermSelect({ choices, termId, onChange }: { choices: TermChoice[]; termId: string | null; onChange: (id: string) => void }) {
  if (choices.length <= 1) return null;
  return (
    <label className="flex items-center gap-2 text-sm text-gray-600">
      Term
      <select value={termId ?? ''} onChange={e => onChange(e.target.value)} className="input-field max-w-xs">
        {choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
    </label>
  );
}
