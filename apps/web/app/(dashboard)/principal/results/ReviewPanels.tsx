'use client';

/**
 * The numbers behind an approval decision.
 *
 * The approval dashboard shows subject name, teacher name and a scored/total count.
 * Approving from that alone confirms entry is COMPLETE, not that it is CORRECT. These
 * two panels supply the missing half, at the two granularities a principal actually
 * moves between:
 *
 *   ClassSummaryPanel  — students x subjects: weighted totals, grades, positions.
 *                        Scanning view: tells you WHERE to look.
 *   SubjectSheetPanel  — one subject, per-component (CA1/CA2/Exam) per student.
 *                        Detail view: tells you WHAT is wrong once you are there.
 *
 * Both are read-only. Approve, publish and return stay on the dashboard behind their
 * existing confirmations — this changes what the principal can see, not what they can
 * do. Neither is gated on publication: a principal reviewing marks before approving
 * them has to see the unapproved state, which is the whole point.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

// ── API shapes (mirror apps/api/src/services/resultEngine.ts) ──────────────────

interface ComponentScore {
  component_id: string;
  name: string;
  max_score: number;
  weight_percent: number;
  score: number | null;
  contribution: number;
}

interface StudentSubjectResult {
  total_score: number;
  grade: string;
  remark: string;
  components: ComponentScore[];
}

interface SubjectResult {
  subject_id: string;
  subject_name: string;
  subject_code: string;
  result: StudentSubjectResult | null;
}

interface StudentClassResult {
  student_id: string;
  admission_no: string;
  first_name: string;
  last_name: string;
  subjects: SubjectResult[];
  overall_average: number;
  subjects_scored: number;
  position: number;
}

interface ClassResult {
  class_id: string;
  class_name: string;
  term_id: string;
  term_name: string;
  students: StudentClassResult[];
  subject_averages: Record<string, { subject_name: string; average: number }>;
  total_students: number;
}

// Mirrors apps/api/src/db/queries/scores.ts ClassSheetResult.
interface ComponentInfo {
  id: string;
  name: string;
  max_score: number;
  weight_percent: number;
}

interface SheetStudent {
  student_id: string;
  admission_no: string;
  first_name: string;
  last_name: string;
  scores: Record<string, { score_id: string; score: number } | null>;
}

interface ClassSheetResult {
  class_info: { id: string; name: string; level: string; stream: string | null };
  subject_info: { id: string; name: string; code: string };
  term_info: { id: string; name: string };
  components: ComponentInfo[];
  students: SheetStudent[];
}

// ── Shared chrome ──────────────────────────────────────────────────────────────

/** Wide overlay. The page's own Modal is max-w-md, which cannot hold these tables. */
function WidePanel({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Escape closes, and the body does not scroll behind the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 bg-black/40 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-6xl my-4">
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-200 sticky top-0 bg-white rounded-t-xl">
          <div>
            <h3 className="text-base font-semibold text-gray-900">{title}</h3>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600 shrink-0 ml-4">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

function PanelState({ loading, error, empty }: { loading: boolean; error: string; empty?: string }) {
  if (loading) return <p className="py-10 text-center text-sm text-gray-500">Loading…</p>;
  if (error) return <p className="py-10 text-center text-sm text-red-600">{error}</p>;
  if (empty) return <p className="py-10 text-center text-sm text-gray-500">{empty}</p>;
  return null;
}

/** An unscored subject is meaningfully different from a zero, so it is never shown as one. */
const NOT_SCORED = <span className="text-gray-300">—</span>;

// ── Class summary: students x subjects ─────────────────────────────────────────

export function ClassSummaryPanel({
  schoolId,
  classId,
  termId,
  className,
  onClose,
}: {
  schoolId: string;
  classId: string;
  termId: string;
  className: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ClassResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: ClassResult }>(
      `/api/schools/${schoolId}/results/class-summary?class_id=${classId}&term_id=${termId}`
    )
      .then(({ data: d }) => { if (!cancelled) setData(d); })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load the class summary');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId, classId, termId]);

  // Column order comes from the first student who has any subjects, so the header and
  // every row agree even when a student is missing a subject entirely.
  const subjectColumns = data?.students[0]?.subjects ?? [];

  return (
    <WidePanel
      title={`${className} — result summary`}
      subtitle={data ? `${data.term_name} · ${data.total_students} student${data.total_students === 1 ? '' : 's'}` : undefined}
      onClose={onClose}
    >
      <PanelState loading={loading} error={error} />
      {!loading && !error && data && (
        data.students.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-500">No students are enrolled in this class for this term.</p>
        ) : (
          <>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap">Student</th>
                    <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap">Adm. no.</th>
                    {subjectColumns.map(s => (
                      <th key={s.subject_id} className="text-right px-4 py-2.5 font-medium whitespace-nowrap" title={s.subject_name}>
                        {s.subject_code || s.subject_name}
                      </th>
                    ))}
                    <th className="text-right px-4 py-2.5 font-medium whitespace-nowrap">Average</th>
                    <th className="text-right px-4 py-2.5 font-medium whitespace-nowrap">Position</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.students.map(st => (
                    <tr key={st.student_id}>
                      <td className="px-4 py-3 text-gray-900 font-medium whitespace-nowrap">
                        {st.first_name} {st.last_name}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{st.admission_no}</td>
                      {subjectColumns.map(col => {
                        const subj = st.subjects.find(s => s.subject_id === col.subject_id);
                        return (
                          <td key={col.subject_id} className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                            {subj?.result
                              ? <>{subj.result.total_score}<span className="text-gray-400 ml-1.5">{subj.result.grade}</span></>
                              : NOT_SCORED}
                          </td>
                        );
                      })}
                      <td className="px-4 py-3 text-right text-gray-900 font-medium whitespace-nowrap">
                        {st.subjects_scored > 0 ? st.overall_average : NOT_SCORED}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600 whitespace-nowrap">
                        {st.subjects_scored > 0 ? st.position : NOT_SCORED}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Totals are weighted by each component&apos;s share of the subject. A dash means no score has been
              entered yet, which is not the same as a zero. Position is a standard competition ranking, so
              students on the same average share a position.
            </p>
          </>
        )
      )}
    </WidePanel>
  );
}

// ── Subject sheet: one subject, per component ──────────────────────────────────

export function SubjectSheetPanel({
  schoolId,
  classId,
  subjectId,
  termId,
  subjectName,
  className,
  onClose,
}: {
  schoolId: string;
  classId: string;
  subjectId: string;
  termId: string;
  subjectName: string;
  className: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ClassSheetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: ClassSheetResult }>(
      `/api/schools/${schoolId}/scores/class-sheet?class_id=${classId}&subject_id=${subjectId}&term_id=${termId}`
    )
      .then(({ data: d }) => { if (!cancelled) setData(d); })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load the score sheet');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId, classId, subjectId, termId]);

  return (
    <WidePanel
      title={`${subjectName} — ${className}`}
      subtitle={data ? `${data.term_info.name} · entered scores, read-only` : undefined}
      onClose={onClose}
    >
      <PanelState loading={loading} error={error} />
      {!loading && !error && data && (
        data.students.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-500">No students are enrolled in this class for this term.</p>
        ) : (
          <>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap">Student</th>
                    <th className="text-left px-4 py-2.5 font-medium whitespace-nowrap">Adm. no.</th>
                    {data.components.map(c => (
                      <th key={c.id} className="text-right px-4 py-2.5 font-medium whitespace-nowrap">
                        {c.name}
                        <span className="block text-[10px] normal-case text-gray-400 font-normal">
                          max {c.max_score} · {c.weight_percent}%
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.students.map(st => (
                    <tr key={st.student_id}>
                      <td className="px-4 py-3 text-gray-900 font-medium whitespace-nowrap">
                        {st.first_name} {st.last_name}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{st.admission_no}</td>
                      {data.components.map(c => (
                        <td key={c.id} className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                          {st.scores[c.id] ? st.scores[c.id]!.score : NOT_SCORED}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Raw component scores as the teacher entered them. A dash means nothing has been entered for that
              component. To send this subject back for correction, close this and use Return on the subject row.
            </p>
          </>
        )
      )}
    </WidePanel>
  );
}
