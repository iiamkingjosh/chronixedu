'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/app/providers';
import { useParentContext } from '@/lib/parentContext';
import { apiFetch } from '@/lib/api';
import { useParentTerms } from '@/lib/useParentTerms';
import { TermSelect } from '@/components/TermSelect';

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
  term_id: string;
  overall_average: number;
  position: number;
  total_students: number;
  subjects: SubjectResult[];
  result_status: string | null;
  report_card: { available: boolean; pdf_url: string | null };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ParentResultsPage() {
  const { schoolId } = useAuth();
  const { selectedChild, loading: childrenLoading, error: childrenError, children: linkedChildren } = useParentContext();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [results, setResults] = useState<ResultsData | null>(null);
  // Any term that has begun, not only the current one (Moses, 8 Oct 2026).
  const { choices, termId, setTermId, error: termsError } = useParentTerms(schoolId);

  useEffect(() => {
    if (!schoolId || !selectedChild || !termId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    // Cleared first, so another child's or term's results never sit under this one's name.
    setResults(null);

    apiFetch<{ success: boolean; data: ResultsData }>(
      `/api/schools/${schoolId}/parent/students/${selectedChild.student_id}/results?term_id=${termId}`
    )
      .then(res => {
        if (cancelled || !res) return;
        setResults(res.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load results');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId, selectedChild, termId]);

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

  if (childrenLoading) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  if (childrenError) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{childrenError}</div>
      </div>
    );
  }

  if (linkedChildren.length === 0 || !selectedChild) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          No students are linked to your account yet. Please contact your school&apos;s administration.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Results</h1>
          <p className="text-sm text-gray-500">
            {selectedChild.first_name} {selectedChild.last_name} · {selectedChild.class_name ?? 'No class assigned'}
          </p>
          <div className="mt-2"><TermSelect choices={choices} termId={termId} onChange={setTermId} /></div>
        </div>
        {results && (() => {
          // A published card whose link could not be made used to give a button that did nothing (href "#").
          const ready = results.report_card.available && !!results.report_card.pdf_url;
          return (
            <div className="shrink-0 text-right">
              <a
                href={ready ? results.report_card.pdf_url! : undefined}
                target={ready ? '_blank' : undefined}
                rel={ready ? 'noopener noreferrer' : undefined}
                aria-disabled={!ready}
                title={ready ? 'Download report card' : results.report_card.available ? 'The report card could not be opened just now' : 'Report card not yet published'}
                className={`inline-block px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap ${
                  ready ? 'bg-[#003366] text-white hover:bg-[#002347]' : 'bg-gray-200 text-gray-400 cursor-not-allowed pointer-events-none'
                }`}
              >
                Download Report Card
              </a>
              {results.report_card.available && !results.report_card.pdf_url && (
                <p className="text-xs text-red-600 mt-1">The report card could not be opened just now. Refresh the page to try again.</p>
              )}
            </div>
          );
        })()}
      </div>

      {termsError && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">{termsError}</div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading results…</p>
      ) : results && results.result_status !== 'published' ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-10 text-center">
          <p className="text-sm font-medium text-amber-900">Results not published yet</p>
          <p className="text-xs text-amber-700 mt-2 max-w-sm mx-auto">
            {selectedChild.first_name}&apos;s scores for this term become visible here once the
            school has finished marking and published the results.
          </p>
        </div>
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
