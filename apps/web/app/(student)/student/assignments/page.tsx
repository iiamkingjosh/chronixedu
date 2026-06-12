'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Submission {
  id: string;
  submitted_at: string;
  file_url: string;
  grade: number | null;
  feedback: string | null;
}

interface Assignment {
  id: string;
  subject_name: string;
  title: string;
  description: string | null;
  due_date: string;
  attachment_url: string | null;
  submission: Submission | null;
}

// ── Submission form ───────────────────────────────────────────────────────────

function SubmitForm({
  schoolId,
  assignment,
  onSubmitted,
}: {
  schoolId: string;
  assignment: Assignment;
  onSubmitted: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setSubmitting(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      await apiUpload(`/api/schools/${schoolId}/assignments/${assignment.id}/submissions`, formData);
      setFile(null);
      onSubmitted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to submit assignment');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-2">
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex items-center gap-2">
        <input
          type="file"
          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          className="block flex-1 text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
        />
        <button
          type="submit"
          disabled={!file || submitting}
          className="shrink-0 px-4 py-2 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002347] disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </form>
  );
}

// ── Assignment card ───────────────────────────────────────────────────────────

function AssignmentCard({
  schoolId,
  assignment,
  onSubmitted,
}: {
  schoolId: string;
  assignment: Assignment;
  onSubmitted: () => void;
}) {
  const isPastDue = new Date(assignment.due_date).getTime() < Date.now();
  const { submission } = assignment;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{assignment.title}</h2>
          <p className="text-xs text-gray-500">{assignment.subject_name}</p>
        </div>
        <span className={`shrink-0 text-[10px] font-medium uppercase tracking-wide px-2 py-1 rounded-md border ${
          submission?.grade !== null && submission?.grade !== undefined
            ? 'bg-green-50 text-green-700 border-green-200'
            : submission
            ? 'bg-blue-50 text-blue-700 border-blue-200'
            : isPastDue
            ? 'bg-red-50 text-red-700 border-red-200'
            : 'bg-gray-50 text-gray-500 border-gray-200'
        }`}>
          {submission?.grade !== null && submission?.grade !== undefined
            ? 'Graded'
            : submission
            ? 'Submitted'
            : isPastDue
            ? 'Past due'
            : 'Pending'}
        </span>
      </div>

      {assignment.description && (
        <p className="text-sm text-gray-700 whitespace-pre-wrap mt-1">{assignment.description}</p>
      )}

      <p className="text-xs text-gray-400 mt-2">
        Due {new Date(assignment.due_date).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </p>

      {assignment.attachment_url && (
        <a href={assignment.attachment_url} target="_blank" rel="noopener noreferrer" className="inline-block mt-2 text-sm text-[#2472B4] hover:underline">
          View attachment
        </a>
      )}

      {submission ? (
        <div className="mt-3 border-t border-gray-100 pt-3 space-y-1">
          <p className="text-xs text-gray-500">
            Submitted {new Date(submission.submitted_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {' · '}
            <a href={submission.file_url} target="_blank" rel="noopener noreferrer" className="text-[#2472B4] hover:underline">
              View your submission
            </a>
          </p>
          {submission.grade !== null && submission.grade !== undefined ? (
            <div className="mt-1">
              <p className="text-sm font-semibold text-gray-900">Grade: {submission.grade}</p>
              {submission.feedback && <p className="text-sm text-gray-600 mt-0.5">{submission.feedback}</p>}
            </div>
          ) : (
            <p className="text-xs text-gray-400">Awaiting grading.</p>
          )}
          {!isPastDue && (
            <p className="text-xs text-gray-400">You can resubmit before the due date to replace this submission.</p>
          )}
          {!isPastDue && <SubmitForm schoolId={schoolId} assignment={assignment} onSubmitted={onSubmitted} />}
        </div>
      ) : isPastDue ? (
        <p className="mt-3 text-xs text-red-600 border-t border-gray-100 pt-3">
          The due date has passed. Submissions are no longer accepted.
        </p>
      ) : (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <SubmitForm schoolId={schoolId} assignment={assignment} onSubmitted={onSubmitted} />
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudentAssignmentsPage() {
  const { schoolId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [assignments, setAssignments] = useState<Assignment[]>([]);

  const load = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: Assignment[] }>(`/api/schools/${schoolId}/assignments`)
      .then(({ data }) => setAssignments(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load assignments'))
      .finally(() => setLoading(false));
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Assignments</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading assignments…</p>
      ) : assignments.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 text-center">
          <p className="text-sm text-gray-500">No assignments have been posted yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {assignments.map(a => (
            <AssignmentCard key={a.id} schoolId={schoolId!} assignment={a} onSubmitted={load} />
          ))}
        </div>
      )}
    </div>
  );
}
