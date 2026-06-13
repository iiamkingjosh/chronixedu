'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassRow {
  id: string;
  name: string;
  level: string;
  stream: string | null;
}

interface FlatTerm {
  id: string;
  name: string;
  session_id: string;
  session_name: string;
  is_current: boolean;
}

interface ExistingReportCard {
  id: string;
  student_id: string;
  pdf_url: string | null;
  is_published: boolean;
  generated_at: string;
}

type JobStatus = 'pending' | 'running' | 'done' | 'error';

interface ReportCardJob {
  jobId: string;
  status: JobStatus;
  classId: string;
  termId: string;
  schoolId: string;
  total: number;
  completed: number;
  failed: number;
  errors: string[];
}

interface StudentSearchResult {
  id: string;
  admission_no: string;
  first_name: string;
  last_name: string;
  class_name: string | null;
}

type ToastFn = (message: string, type?: 'success' | 'error') => void;

// ── Toast & shared bits ───────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show: ToastFn = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputClass = 'input-field';

function badgeClass(tone: 'gray' | 'blue' | 'green' | 'red'): string {
  const tones: Record<string, string> = {
    gray:  'badge-default',
    blue:  'badge-info',
    green: 'badge-success',
    red:   'badge-danger',
  };
  return tones[tone];
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function termLabel(t: FlatTerm): string {
  return `${t.session_name} — ${t.name}`;
}

function latestGeneratedAt(cards: ExistingReportCard[]): string | null {
  if (cards.length === 0) return null;
  return cards.reduce((latest, c) => (c.generated_at > latest ? c.generated_at : latest), cards[0].generated_at);
}

// ── Generation section ────────────────────────────────────────────────────────

function GenerationSection({
  schoolId,
  classes,
  terms,
  defaultTermId,
  show,
}: {
  schoolId: string;
  classes: ClassRow[];
  terms: FlatTerm[];
  defaultTermId: string | null;
  show: ToastFn;
}) {
  const [classId, setClassId] = useState<string | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [cards, setCards] = useState<ExistingReportCard[]>([]);
  const [totalStudents, setTotalStudents] = useState<number | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [job, setJob] = useState<ReportCardJob | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => { if (classes.length > 0 && !classId) setClassId(classes[0].id); }, [classes, classId]);
  useEffect(() => { if (terms.length > 0 && !termId) setTermId(defaultTermId ?? terms[0].id); }, [terms, termId, defaultTermId]);

  const selectedTerm = terms.find(t => t.id === termId) ?? null;

  const loadStatus = useCallback(() => {
    if (!classId || !termId || !selectedTerm) return;
    setLoadingStatus(true);
    Promise.all([
      apiFetch<{ success: boolean; data: ExistingReportCard[] }>(
        `/api/schools/${schoolId}/results/report-cards?class_id=${classId}&term_id=${termId}`
      ),
      apiFetch<{ success: boolean; data: unknown[]; meta: { total: number } }>(
        `/api/schools/${schoolId}/students?class_id=${classId}&session_id=${selectedTerm.session_id}&limit=1`
      ),
    ])
      .then(([cardsRes, studentsRes]) => {
        setCards(cardsRes.data);
        setTotalStudents(studentsRes.meta.total);
      })
      .catch((err: unknown) => show(err instanceof Error ? err.message : 'Failed to load report card status', 'error'))
      .finally(() => setLoadingStatus(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, classId, termId, selectedTerm]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Poll an in-progress generation job every two seconds until it settles.
  useEffect(() => {
    if (!job) return;
    if (job.status === 'done' || job.status === 'error') {
      loadStatus();
      return;
    }
    const timer = setTimeout(() => {
      apiFetch<{ success: boolean; data: ReportCardJob }>(`/api/schools/${schoolId}/results/report-card-jobs/${job.jobId}`)
        .then(({ data }) => setJob(data))
        .catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, schoolId]);

  async function handleGenerate() {
    if (!classId || !termId) return;
    setGenerating(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { job_id: string; total_students: number; message: string } }>(
        `/api/schools/${schoolId}/results/generate-report-cards`,
        { method: 'POST', body: JSON.stringify({ class_id: classId, term_id: termId }) }
      );
      show(res.data.message);
      setJob({
        jobId: res.data.job_id, status: 'pending', classId, termId, schoolId,
        total: res.data.total_students, completed: 0, failed: 0, errors: [],
      });
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to start report card generation', 'error');
    } finally {
      setGenerating(false);
    }
  }

  function handleViewSample() {
    const sample = cards.find(c => c.pdf_url);
    if (sample?.pdf_url) window.open(sample.pdf_url, '_blank', 'noopener,noreferrer');
  }

  const hasGenerated = cards.length > 0;
  const sampleAvailable = cards.some(c => c.pdf_url);
  const jobActive = job ? (job.status === 'pending' || job.status === 'running') : false;

  return (
    <div className="card p-5">
      <h2 className="font-heading text-base font-semibold text-gray-900 mb-1">Generate report cards</h2>
      <p className="text-sm text-gray-500 mb-4">Pick a class and term to review generation status or generate PDF report cards.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <Field label="Class">
          <select value={classId ?? ''} onChange={e => setClassId(e.target.value || null)} className={inputClass}>
            {classes.map(c => <option key={c.id} value={c.id}>{c.name} ({c.level})</option>)}
          </select>
        </Field>
        <Field label="Term">
          <select value={termId ?? ''} onChange={e => setTermId(e.target.value || null)} className={inputClass}>
            {terms.map(t => <option key={t.id} value={t.id}>{termLabel(t)}{t.is_current ? ' (current)' : ''}</option>)}
          </select>
        </Field>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 mb-4">
        {loadingStatus ? (
          <p className="text-sm text-gray-500">Loading status…</p>
        ) : (
          <>
            <p className="text-sm text-gray-700">
              {hasGenerated
                ? `${cards.length} of ${totalStudents ?? '—'} student report card(s) generated`
                : 'No report cards have been generated yet for this class and term.'}
            </p>
            {hasGenerated && (
              <p className="text-xs text-gray-400 mt-0.5">Last generated {formatDateTime(latestGeneratedAt(cards))}</p>
            )}
          </>
        )}
      </div>

      {job && (
        <div className={`mb-4 rounded-lg px-4 py-3 border text-sm ${
          job.status === 'error' ? 'bg-red-50 border-red-200 text-red-700'
            : job.status === 'done' ? 'bg-green-50 border-green-200 text-green-700'
            : 'bg-blue-50 border-blue-200 text-blue-700'
        }`}>
          <p className="font-medium">
            {job.status === 'pending' && 'Queued — generation will start shortly…'}
            {job.status === 'running' && `Generating… ${job.completed} of ${job.total} complete`}
            {job.status === 'done' && `Done — ${job.completed} generated${job.failed > 0 ? `, ${job.failed} failed` : ''}`}
            {job.status === 'error' && 'Report card generation failed.'}
          </p>
          {job.errors.length > 0 && (
            <ul className="mt-1.5 list-disc list-inside text-xs space-y-0.5">
              {job.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleGenerate}
          disabled={generating || jobActive || !classId || !termId}
          className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {jobActive ? 'Generating…' : 'Generate report cards'}
        </button>
        <button
          onClick={handleViewSample}
          disabled={!sampleAvailable}
          className="btn-secondary disabled:opacity-40 disabled:cursor-not-allowed"
        >
          View sample
        </button>
      </div>
    </div>
  );
}

// ── Student lookup section ────────────────────────────────────────────────────

function StudentLookupSection({
  schoolId,
  terms,
  defaultTermId,
  show,
}: {
  schoolId: string;
  terms: FlatTerm[];
  defaultTermId: string | null;
  show: ToastFn;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StudentSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<StudentSearchResult | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [card, setCard] = useState<{ pdf_url: string | null; generated_at: string; is_published: boolean } | null>(null);
  const [cardError, setCardError] = useState('');
  const [loadingCard, setLoadingCard] = useState(false);

  useEffect(() => { if (terms.length > 0 && !termId) setTermId(defaultTermId ?? terms[0].id); }, [terms, termId, defaultTermId]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId) return;
    const q = query.trim();
    if (q.length < 2) {
      show('Enter at least 2 characters to search', 'error');
      return;
    }
    setSearching(true);
    setSelected(null);
    setCard(null);
    setCardError('');
    try {
      const res = await apiFetch<{ success: boolean; data: StudentSearchResult[] }>(
        `/api/schools/${schoolId}/students?search=${encodeURIComponent(q)}&limit=10`
      );
      setResults(res.data);
      if (res.data.length === 0) show('No students matched your search', 'error');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Search failed', 'error');
    } finally {
      setSearching(false);
    }
  }

  const loadCard = useCallback(() => {
    if (!schoolId || !selected || !termId) return;
    setLoadingCard(true);
    setCardError('');
    setCard(null);
    apiFetch<{ success: boolean; data: { pdf_url: string | null; generated_at: string; is_published: boolean } }>(
      `/api/schools/${schoolId}/students/${selected.id}/report-card?term_id=${termId}`
    )
      .then(({ data }) => setCard(data))
      .catch((err: unknown) => setCardError(err instanceof Error ? err.message : 'No report card found for this student and term'))
      .finally(() => setLoadingCard(false));
  }, [schoolId, selected, termId]);

  useEffect(() => { loadCard(); }, [loadCard]);

  return (
    <div className="card p-5">
      <h2 className="font-heading text-base font-semibold text-gray-900 mb-1">Look up a student&rsquo;s report card</h2>
      <p className="text-sm text-gray-500 mb-4">Search for a student to view or download their report card for any term.</p>

      <form onSubmit={handleSearch} className="flex items-center gap-3 mb-4">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by name or admission number…"
          className={`${inputClass} flex-1`}
        />
        <button type="submit" disabled={searching} className="btn-primary disabled:opacity-50">
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {results.length > 0 && (
        <div className="mb-4 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-56 overflow-y-auto">
          {results.map(student => {
            const active = student.id === selected?.id;
            return (
              <button
                key={student.id}
                onClick={() => setSelected(student)}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors duration-200 ${active ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
              >
                <span className="font-medium text-gray-900">{student.first_name} {student.last_name}</span>
                <span className="ml-2 text-gray-400">{student.admission_no}</span>
                {student.class_name && <span className="ml-2 text-gray-400">· {student.class_name}</span>}
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <p className="text-sm font-medium text-gray-900">
              {selected.first_name} {selected.last_name} <span className="text-gray-400 font-normal">({selected.admission_no})</span>
            </p>
            <select value={termId ?? ''} onChange={e => setTermId(e.target.value || null)} className={`${inputClass} w-auto`}>
              {terms.map(t => <option key={t.id} value={t.id}>{termLabel(t)}{t.is_current ? ' (current)' : ''}</option>)}
            </select>
          </div>

          {loadingCard ? (
            <p className="text-sm text-gray-500">Loading report card…</p>
          ) : card?.pdf_url ? (
            <div className="flex flex-wrap items-center gap-3">
              <a href={card.pdf_url} target="_blank" rel="noopener noreferrer" className="btn-primary">
                View report card
              </a>
              <a href={card.pdf_url} download className="btn-secondary">
                Download
              </a>
              <span className={badgeClass(card.is_published ? 'green' : 'gray')}>{card.is_published ? 'Published' : 'Not yet published'}</span>
              <span className="text-xs text-gray-400">Generated {formatDateTime(card.generated_at)}</span>
            </div>
          ) : (
            <p className="text-sm text-gray-500">{cardError || 'No report card has been generated for this student and term yet.'}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PrincipalReportCardsPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [terms, setTerms] = useState<FlatTerm[]>([]);
  const [currentTermId, setCurrentTermId] = useState<string | null>(null);

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([
      apiFetch<{ success: boolean; data: ClassRow[] }>(`/api/schools/${schoolId}/classes`),
      apiFetch<{ success: boolean; data: { id: string; name: string; terms: { id: string; session_id: string; name: string; is_current: boolean }[] }[] }>(
        `/api/schools/${schoolId}/sessions`
      ),
    ])
      .then(([classesRes, sessionsRes]) => {
        if (cancelled) return;
        const flat: FlatTerm[] = [];
        let current: string | null = null;
        for (const session of sessionsRes.data) {
          for (const term of session.terms) {
            flat.push({ id: term.id, name: term.name, session_id: term.session_id, session_name: session.name, is_current: term.is_current });
            if (term.is_current) current = term.id;
          }
        }
        setClasses(classesRes.data);
        setTerms(flat);
        setCurrentTermId(current);
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load report card data'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId]);

  if (!schoolId || loading) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <div className="skeleton h-6 w-40 mb-2" />
        <div className="skeleton h-4 w-96 mb-6" />
        <div className="space-y-6">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="card p-5 space-y-3">
              <div className="skeleton h-4 w-48" />
              <div className="skeleton h-9 w-full" />
              <div className="skeleton h-16 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-8">
      {toast && (
        <div className={`toast-enter fixed top-4 right-4 z-50 px-4 py-3 rounded-md shadow-lift text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <h1 className="font-heading text-xl font-semibold text-gray-900 mb-1">Report Cards</h1>
      <p className="text-sm text-gray-500 mb-6">Generate report card PDFs for a class and term, or look up an individual student&rsquo;s report card.</p>

      {classes.length === 0 || terms.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          {classes.length === 0 ? 'No classes have been set up for this school yet.' : 'No academic terms have been set up for this school yet.'}
        </div>
      ) : (
        <div className="space-y-6">
          <GenerationSection schoolId={schoolId} classes={classes} terms={terms} defaultTermId={currentTermId} show={show} />
          <StudentLookupSection schoolId={schoolId} terms={terms} defaultTermId={currentTermId} show={show} />
        </div>
      )}
    </div>
  );
}
