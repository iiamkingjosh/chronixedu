'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { filterPalette, paletteEntriesForRole } from '@/lib/commandPalette';

/**
 * Ctrl+K (⌘K on a Mac) page search, opened from the top bar. Pages only, built from the same
 * source as the sidebar (lib/commandPalette.ts), so it never offers a page the role cannot open.
 * Rendered only inside the signed-in dashboard layout — never on the login page or anywhere
 * before authentication, where it would expose the app's structure.
 *
 * Tappable first: most staff are on phones. The button opens it, every result is a full-width
 * button, and an empty query lists every page, so typing is optional. Keyboard: Ctrl/⌘+K
 * toggles, arrows move, Enter goes, Escape closes.
 */
export default function CommandPalette({ role }: { role: string }) {
  const router = useRouter();
  const entries = useMemo(() => paletteEntriesForRole(role), [role]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Detected, not assumed — and only after mount, so the server render never guesses.
  const [isMac, setIsMac] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => filterPalette(entries, query), [entries, query]);

  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform || navigator.platform || navigator.userAgent;
    setIsMac(/mac|iphone|ipad|ipod/i.test(platform));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after the dialog renders.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (entries.length === 0) return null; // nothing this role could open from here

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[active]) go(results[active].href);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }

  const shortcut = isMac === null ? null : isMac ? '⌘K' : 'Ctrl K';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm text-gray-500 hover:border-gray-300 hover:text-gray-700"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
        </svg>
        <span>Search</span>
        {shortcut && (
          <kbd className="hidden sm:inline rounded border border-gray-200 bg-white px-1.5 text-[11px] font-medium text-gray-400">{shortcut}</kbd>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div role="dialog" aria-modal="true" aria-label="Search pages" className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center gap-2 border-b border-gray-100 px-4">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKey}
                placeholder="Search pages…"
                aria-label="Search pages"
                aria-controls="command-palette-results"
                aria-activedescendant={results[active] ? `command-palette-item-${active}` : undefined}
                className="w-full py-3.5 text-base text-gray-900 outline-none placeholder:text-gray-400"
              />
              <button type="button" onClick={() => setOpen(false)} className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100">
                Esc
              </button>
            </div>
            <ul ref={listRef} id="command-palette-results" role="listbox" className="max-h-[60vh] overflow-y-auto py-1">
              {results.length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-gray-500">No pages match “{query}”.</li>
              )}
              {results.map((r, i) => (
                <li key={r.href} id={`command-palette-item-${i}`} role="option" aria-selected={i === active} data-index={i}>
                  <button
                    type="button"
                    onClick={() => go(r.href)}
                    onMouseEnter={() => setActive(i)}
                    className={`flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-2 text-left ${i === active ? 'bg-[#003366]/5' : ''}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-gray-900">{r.label}</span>
                      {r.description && <span className="block truncate text-xs text-gray-500">{r.description}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-gray-400">{r.group}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
