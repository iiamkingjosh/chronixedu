'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AssignmentOption {
  class_id: string;
  class_name: string;
  subject_id: string;
  subject_name: string;
}

interface Assignment {
  id: string;
  class_id: string;
  class_name: string;
  subject_id: string;
  subject_name: string;
  title: string;
  description: string | null;
  due_date: string;
  attachment_url: string | null;
  created_at: string;
  students_total: number;
  students_submitted: number;
  students_graded: number;
}

interface Submission {
  id: string;
  student_id: string;
  submitted_at: string;
  file_url: string;
  grade: number | null;
  feedback: string | null;
}

interface SubmissionGridRow {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  submission: Submission | null;
}

type ToastFn = (message: string, type?: 'success' | 'error') => void;

// ── Toast ─────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show: ToastFn = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

// ── Create assignment form ───────────────────────────────────────────────────

function CreateAssignmentForm({
  schoolId,
  options,
  show,
  onCreated,
}: {
  schoolId: string;
  options: AssignmentOption[];
  show: ToastFn;
  onCreated: () => void;
}) {
  const [classSubject, setClassSubject] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (options.length > 0 && !classSubject) {
      setClassSubject(`${options[0].class_id}:${options[0].subject_id}`);
    }
  }, [options, classSubject]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!classSubject || !title || !dueDate) return;

    const [class_id, subject_id] = classSubject.split(':');

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('class_id', class_id);
      formData.append('subject_id', subject_id);
      formData.append('title', title);
      if (description) formData.append('description', description);
      formData.append('due_date', new Date(dueDate).toISOString());
      if (file) formData.append('attachment', file);

      await apiUpload(`/api/schools/${schoolId}/assignments`, formData);
      show('Assignment created');
      setTitle('');
      setDescription('');
      setDueDate('');
      setFile(null);
      onCreated();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to create assignment', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (options.length === 0) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
        You have no class/subject assignments for the active term, so you cannot create assignments yet.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-4">
      <h2 className="text-sm font-semibold text-gray-900">New assignment</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Class &amp; Subject</label>
          <select
            value={classSubject}
            onChange={e => setClassSubject(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            {options.map(o => (
              <option key={`${o.class_id}:${o.subject_id}`} value={`${o.class_id}:${o.subject_id}`}>
                {o.class_name} — {o.subject_name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Due date</label>
          <input
            type="datetime-local"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            required
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          required
          maxLength={200}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Description</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={3}
          maxLength={5000}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Attachment (optional — PDF, DOC, DOCX, JPG, PNG)</label>
        <input
          type="file"
          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
        />
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
      >
        {submitting ? 'Creating…' : 'Create assignment'}
      </button>
    </form>
  );
}

// ── Submission grid ───────────────────────────────────────────────────────────

function SubmissionGrid({
  schoolId,
  assignment,
  show,
}: {
  schoolId: string;
  assignment: Assignment;
  show: ToastFn;
}) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<SubmissionGridRow[]>([]);
  const [edits, setEdits] = useState<Record<string, { grade: string; feedback: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: { assignment: Assignment; submissions: SubmissionGridRow[] } }>(
      `/api/schools/${schoolId}/assignments/${assignment.id}/submissions`
    )
      .then(({ data }) => {
        setRows(data.submissions);
        const initial: Record<string, { grade: string; feedback: string }> = {};
        for (const row of data.submissions) {
          initial[row.student_id] = {
            grade: row.submission?.grade !== null && row.submission?.grade !== undefined ? String(row.submission.grade) : '',
            feedback: row.submission?.feedback ?? '',
          };
        }
        setEdits(initial);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load submissions'))
      .finally(() => setLoading(false));
  }, [schoolId, assignment.id]);

  useEffect(() => { load(); }, [load]);

  async function handleSaveGrade(studentId: string) {
    const edit = edits[studentId];
    if (!edit) return;

    setSaving(studentId);
    try {
      const grade = edit.grade === '' ? null : Number(edit.grade);
      await apiFetch(`/api/schools/${schoolId}/assignments/${assignment.id}/submissions/${studentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ grade, feedback: edit.feedback || null }),
      });
      show('Grade saved');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to save grade', 'error');
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-gray-500 py-6 text-center">Loading submissions…</p>;
  }

  if (error) {
    return <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>;
  }

  return (
    <div className="overflow-x-auto border border-gray-200 rounded-xl">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-xs uppercase text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Student</th>
            <th className="px-4 py-3 text-left font-medium">Admission No.</th>
            <th className="px-4 py-3 text-left font-medium">Submission</th>
            <th className="px-3 py-3 text-center font-medium">Grade</th>
            <th className="px-4 py-3 text-left font-medium">Feedback</th>
            <th className="px-4 py-3 text-left font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(row => {
            const edit = edits[row.student_id] ?? { grade: '', feedback: '' };
            return (
              <tr key={row.student_id}>
                <td className="px-4 py-2.5 whitespace-nowrap text-gray-900">{row.first_name} {row.last_name}</td>
                <td className="px-4 py-2.5 whitespace-nowrap text-gray-500">{row.admission_no}</td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  {row.submission ? (
                    <a
                      href={row.submission.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#2472B4] hover:underline"
                    >
                      View file
                    </a>
                  ) : (
                    <span className="text-gray-400">Not submitted</span>
                  )}
                </td>
                <td className="px-2 py-2 text-center">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={edit.grade}
                    disabled={!row.submission}
                    onChange={e => setEdits(prev => ({ ...prev, [row.student_id]: { ...edit, grade: e.target.value } }))}
                    className="w-20 text-center border border-gray-300 rounded-md px-1.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:bg-gray-50 disabled:text-gray-300"
                  />
                </td>
                <td className="px-4 py-2 min-w-[200px]">
                  <input
                    type="text"
                    value={edit.feedback}
                    disabled={!row.submission}
                    onChange={e => setEdits(prev => ({ ...prev, [row.student_id]: { ...edit, feedback: e.target.value } }))}
                    className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:bg-gray-50 disabled:text-gray-300"
                  />
                </td>
                <td className="px-4 py-2 whitespace-nowrap">
                  <button
                    onClick={() => handleSaveGrade(row.student_id)}
                    disabled={!row.submission || saving === row.student_id}
                    className="px-3 py-1.5 border border-gray-300 text-xs font-medium text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    {saving === row.student_id ? 'Saving…' : 'Save'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TeacherAssignmentsPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [options, setOptions] = useState<AssignmentOption[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadAssignments = useCallback(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: Assignment[] }>(`/api/schools/${schoolId}/assignments`)
      .then(({ data }) => setAssignments(data))
      .catch((err: unknown) => show(err instanceof Error ? err.message : 'Failed to refresh assignments', 'error'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    Promise.all([
      apiFetch<{ success: boolean; data: Assignment[] }>(`/api/schools/${schoolId}/assignments`),
      apiFetch<{ success: boolean; data: AssignmentOption[] }>(`/api/schools/${schoolId}/dashboard/teacher/score-entry-status`),
    ])
      .then(([assignmentsRes, optionsRes]) => {
        if (cancelled) return;
        setAssignments(assignmentsRes.data);

        const seen = new Set<string>();
        const dedupedOptions: AssignmentOption[] = [];
        for (const o of optionsRes.data) {
          const key = `${o.class_id}:${o.subject_id}`;
          if (!seen.has(key)) {
            seen.add(key);
            dedupedOptions.push({ class_id: o.class_id, class_name: o.class_name, subject_id: o.subject_id, subject_name: o.subject_name });
          }
        }
        setOptions(dedupedOptions);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load assignments');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [schoolId]);

  const expandedAssignment = useMemo(() => assignments.find(a => a.id === expandedId) ?? null, [assignments, expandedId]);

  if (!schoolId || loading) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <p className="text-sm text-gray-500">Loading assignments…</p>
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
    <div className="max-w-5xl mx-auto p-8 space-y-6">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <div>
        <h1 className="text-xl font-semibold text-gray-900">Assignments</h1>
        <p className="text-sm text-gray-500 mt-1">Create assignments and grade student submissions.</p>
      </div>

      <CreateAssignmentForm schoolId={schoolId} options={options} show={show} onCreated={loadAssignments} />

      <div>
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Your assignments</h2>
        {assignments.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center bg-white border border-gray-200 rounded-xl">No assignments created yet.</p>
        ) : (
          <div className="space-y-3">
            {assignments.map(a => {
              const isExpanded = expandedId === a.id;
              const isPastDue = new Date(a.due_date).getTime() < Date.now();
              return (
                <div key={a.id} className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : a.id)}
                    className="w-full text-left px-5 py-4 flex items-center justify-between gap-4 hover:bg-gray-50"
                  >
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{a.title}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {a.class_name} — {a.subject_name} · Due {new Date(a.due_date).toLocaleString()}
                        {isPastDue && <span className="ml-2 text-red-500 font-medium">Past due</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs shrink-0">
                      <span className="inline-flex items-center px-2 py-1 rounded-md font-medium border bg-blue-50 text-blue-700 border-blue-200">
                        {a.students_submitted}/{a.students_total} submitted
                      </span>
                      <span className="inline-flex items-center px-2 py-1 rounded-md font-medium border bg-green-50 text-green-700 border-green-200">
                        {a.students_graded} graded
                      </span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-5 pb-5 border-t border-gray-100 pt-4">
                      {a.description && <p className="text-sm text-gray-600 mb-3 whitespace-pre-wrap">{a.description}</p>}
                      {a.attachment_url && (
                        <a href={a.attachment_url} target="_blank" rel="noopener noreferrer" className="inline-block mb-4 text-sm text-[#2472B4] hover:underline">
                          View attachment
                        </a>
                      )}
                      <SubmissionGrid schoolId={schoolId} assignment={a} show={show} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
