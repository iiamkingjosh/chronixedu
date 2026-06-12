'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ComponentScore {
  component_id: string;
  name: string;
  max_score: number;
  weight_percent: number;
  score: number | null;
  contribution: number;
}

interface SubjectResult {
  subject_id: string;
  subject_name: string;
  subject_code: string;
  components: ComponentScore[];
  total_score: number | null;
  grade: string | null;
  remark: string | null;
}

interface ResultsData {
  student: { class_name: string | null };
  term_id: string;
  overall_average: number;
  position: number;
  total_students: number;
  subjects: SubjectResult[];
  result_status: string | null;
  report_card: { available: boolean; pdf_url: string | null };
}

interface TermOption {
  id: string;
  name: string;
  session_name: string;
  start_date: string;
  is_current: boolean;
}

interface SessionWithTerms {
  id: string;
  name: string;
  terms: { id: string; name: string; start_date: string; is_current: boolean }[];
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudentResultsPage() {
  const { schoolId } = useAuth();

  const [terms, setTerms] = useState<TermOption[]>([]);
  const [selectedTermId, setSelectedTermId] = useState('');
  const [termsLoading, setTermsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [results, setResults] = useState<ResultsData | null>(null);

  // Load all terms (across sessions) for the term selector
  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setTermsLoading(true);

    apiFetch<{ success: boolean; data: SessionWithTerms[] }>(`/api/schools/${schoolId}/sessions`)
      .then(({ data }) => {
        if (cancelled) return;
        const flat: TermOption[] = [];
        for (const session of data) {
          for (const term of session.terms) {
            flat.push({
              id: term.id,
              name: term.name,
              session_name: session.name,
              start_date: term.start_date,
              is_current: term.is_current,
            });
          }
        }
        flat.sort((a, b) => b.start_date.localeCompare(a.start_date));
        setTerms(flat);
        const current = flat.find(t => t.is_current) ?? flat[0];
        if (current) setSelectedTermId(current.id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load terms');
      })
      .finally(() => {
        if (!cancelled) setTermsLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId]);

  // Load results for the selected term
  useEffect(() => {
    if (!schoolId || !selectedTermId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    apiFetch<{ success: boolean; data: ResultsData }>(
      `/api/schools/${schoolId}/student/results?term_id=${selectedTermId}`
    )
      .then(({ data }) => {
        if (cancelled) return;
        setResults(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load results');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId, selectedTermId]);

  const componentColumns = useMemo(() => {
    if (!results) return [];
    const seen = new Map<string, true>();
    for (const subject of results.subjects) {
      for (const comp of subject.components) {
        if (!seen.has(comp.name)) seen.set(comp.name, true);
      }
    }
    return Array.from(seen.keys());
  }, [results]);

  if (termsLoading) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <p className="text-sm text-gray-500 py-10 text-center">Loading…</p>
      </div>
    );
  }

  if (terms.length === 0) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          No academic terms have been set up yet.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Results</h1>
          <p className="text-sm text-gray-500">{results?.student.class_name ?? 'No class assigned'}</p>
        </div>
        {results && (
          <a
            href={results.report_card.available ? (results.report_card.pdf_url ?? '#') : undefined}
            target={results.report_card.available ? '_blank' : undefined}
            rel={results.report_card.available ? 'noopener noreferrer' : undefined}
            aria-disabled={!results.report_card.available}
            title={results.report_card.available ? 'Download report card' : 'Report card not yet published'}
            className={`shrink-0 px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap ${
              results.report_card.available
                ? 'bg-[#003366] text-white hover:bg-[#002347]'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed pointer-events-none'
            }`}
          >
            Download Report Card
          </a>
        )}
      </div>

      <select
        value={selectedTermId}
        onChange={e => setSelectedTermId(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
      >
        {terms.map(t => (
          <option key={t.id} value={t.id}>
            {t.session_name} — {t.name}
          </option>
        ))}
      </select>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading results…</p>
      ) : results && (
        <>
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 grid grid-cols-2 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-[#003366]">{results.overall_average}</p>
              <p className="text-xs text-gray-500 mt-1">Overall average</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-[#003366]">
                {results.position}<span className="text-sm font-normal text-gray-400">/{results.total_students}</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">Class position</p>
            </div>
          </div>

          {results.subjects.length === 0 ? (
            <p className="text-sm text-gray-500 py-10 text-center">No subjects found for this term.</p>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs font-medium uppercase tracking-wide text-gray-400">
                    <th className="px-4 py-3 text-left whitespace-nowrap">Subject</th>
                    {componentColumns.map(name => (
                      <th key={name} className="px-3 py-3 text-center whitespace-nowrap">{name}</th>
                    ))}
                    <th className="px-3 py-3 text-center whitespace-nowrap">Total</th>
                    <th className="px-3 py-3 text-center whitespace-nowrap">Grade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {results.subjects.map(subject => (
                    <tr key={subject.subject_id}>
                      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{subject.subject_name}</td>
                      {componentColumns.map(name => {
                        const comp = subject.components.find(c => c.name === name);
                        return (
                          <td key={name} className="px-3 py-3 text-center text-gray-700">
                            {comp ? (comp.score !== null ? comp.score : '—') : '—'}
                          </td>
                        );
                      })}
                      <td className="px-3 py-3 text-center font-semibold text-gray-900">
                        {subject.total_score !== null ? subject.total_score : '—'}
                      </td>
                      <td className="px-3 py-3 text-center text-gray-700">{subject.grade ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!results.report_card.available && (
            <p className="text-xs text-gray-400 text-center">
              The report card for this term has not been published yet.
            </p>
          )}
        </>
      )}
    </div>
  );
}
