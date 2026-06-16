'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassRow {
  id: string;
  school_id: string;
  name: string;
  level: string;
  stream: string | null;
  form_teacher_id: string | null;
}

interface SubjectRow {
  id: string;
  school_id: string;
  name: string;
  code: string;
  is_active: boolean;
}

interface AssignmentDetail {
  id: string;
  teacher_id: string;
  class_id: string;
  subject_id: string;
  term_id: string;
  school_id: string;
  class_name: string;
  class_level: string;
  class_stream: string | null;
  subject_name: string;
  subject_code: string;
}

interface TeacherOption {
  id: string;
  first_name: string;
  last_name: string;
  title: string | null;
}

type Tab = 'classes' | 'subjects' | 'assignments';

const TABS: { id: Tab; label: string }[] = [
  { id: 'classes',     label: 'Classes' },
  { id: 'subjects',    label: 'Subjects' },
  { id: 'assignments', label: 'Teacher Assignments' },
];

function teacherName(t: TeacherOption): string {
  return t.title ? `${t.title} ${t.first_name} ${t.last_name}` : `${t.first_name} ${t.last_name}`;
}

// ── Toast & shared bits ───────────────────────────────────────────────────────

type ToastFn = (message: string, type?: 'success' | 'error') => void;

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show: ToastFn = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 max-h-[75vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';

function badgeClass(tone: 'gray' | 'green'): string {
  return `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${
    tone === 'green' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500 border-gray-200'
  }`;
}

// ── Generic delete confirmation modal ─────────────────────────────────────────

function DeleteConfirmModal({
  title,
  body,
  confirmLabel,
  confirming,
  onConfirm,
  onClose,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirming: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-sm text-gray-700">{body}</div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className="px-5 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {confirming ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Classes tab ────────────────────────────────────────────────────────────────

const classFormSchema = z.object({
  name:            z.string().min(1, 'Class name is required').max(255),
  level:           z.string().min(1, 'Level is required').max(100),
  stream:          z.string().max(100).optional().or(z.literal('')),
  form_teacher_id: z.string().optional().or(z.literal('')),
});

type ClassForm = z.infer<typeof classFormSchema>;

function ClassFormModal({ schoolId, cls, teachers, onClose, onSaved }: {
  schoolId: string;
  cls: ClassRow | null;
  teachers: TeacherOption[];
  onClose: () => void;
  onSaved: (cls: ClassRow, isNew: boolean) => void;
}) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ClassForm>({
    resolver: zodResolver(classFormSchema),
    defaultValues: { name: cls?.name ?? '', level: cls?.level ?? '', stream: cls?.stream ?? '', form_teacher_id: cls?.form_teacher_id ?? '' },
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: ClassForm) {
    setApiError('');
    const payload = {
      name: values.name,
      level: values.level,
      ...(values.stream ? { stream: values.stream } : {}),
      form_teacher_id: values.form_teacher_id || null,
    };
    try {
      const res = cls
        ? await apiFetch<{ success: boolean; data: ClassRow }>(`/api/schools/${schoolId}/classes/${cls.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await apiFetch<{ success: boolean; data: ClassRow }>(`/api/schools/${schoolId}/classes`, { method: 'POST', body: JSON.stringify(payload) });
      onSaved(res.data, !cls);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to save class');
    }
  }

  return (
    <Modal title={cls ? 'Edit Class' : 'Add Class'} onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Field label="Class name" error={errors.name?.message}>
          <input {...register('name')} className={inputClass} placeholder="JSS 2A" />
        </Field>
        <Field label="Level" error={errors.level?.message}>
          <input {...register('level')} className={inputClass} placeholder="JSS, SSS, Primary…" />
        </Field>
        <Field label="Stream (optional)" error={errors.stream?.message}>
          <input {...register('stream')} className={inputClass} placeholder="Science, Arts…" />
        </Field>
        <Field label="Form Teacher (optional)" error={errors.form_teacher_id?.message}>
          <select {...register('form_teacher_id')} className={inputClass} defaultValue={cls?.form_teacher_id ?? ''}>
            <option value="">— None —</option>
            {teachers.map(t => <option key={t.id} value={t.id}>{teacherName(t)}</option>)}
          </select>
        </Field>

        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Saving…' : cls ? 'Save Changes' : 'Add Class'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ClassesTab({ schoolId, show }: { schoolId: string; show: ToastFn }) {
  const [loading, setLoading] = useState(true);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [formTarget, setFormTarget] = useState<{ cls: ClassRow | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClassRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ success: boolean; data: ClassRow[] }>(`/api/schools/${schoolId}/classes`),
      apiFetch<{ success: boolean; data: { users: TeacherOption[]; total: number } }>(`/api/schools/${schoolId}/users?role=teacher&limit=100`),
    ])
      .then(([classesRes, teachersRes]) => {
        setClasses(classesRes.data);
        setTeachers(teachersRes.data.users);
      })
      .catch(() => show('Failed to load classes', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  function handleSaved(cls: ClassRow, isNew: boolean) {
    setFormTarget(null);
    setClasses(prev => (isNew ? [...prev, cls].sort((a, b) => a.level.localeCompare(b.level) || a.name.localeCompare(b.name)) : prev.map(c => (c.id === cls.id ? cls : c))));
    show(isNew ? 'Class added' : 'Class updated');
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/classes/${deleteTarget.id}`, { method: 'DELETE' });
      setClasses(prev => prev.filter(c => c.id !== deleteTarget.id));
      show('Class deleted');
      setDeleteTarget(null);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to delete class', 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <p className="text-sm text-gray-500">Classes are used to group students and assign teachers and subjects.</p>
        <button
          onClick={() => setFormTarget({ cls: null })}
          className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 transition-colors flex items-center gap-1.5 self-start sm:self-auto shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Class
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading classes…</p>
      ) : classes.length === 0 ? (
        <p className="text-sm text-gray-500">No classes have been created yet.</p>
      ) : (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-5 py-2.5 font-medium">Name</th>
                <th className="text-left px-5 py-2.5 font-medium">Level</th>
                <th className="text-left px-5 py-2.5 font-medium">Stream</th>
                <th className="text-left px-5 py-2.5 font-medium">Form Teacher</th>
                <th className="text-right px-5 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {classes.map(cls => (
                <tr key={cls.id}>
                  <td className="px-5 py-3 text-gray-900 font-medium">{cls.name}</td>
                  <td className="px-5 py-3 text-gray-600">{cls.level}</td>
                  <td className="px-5 py-3 text-gray-600">{cls.stream ?? '—'}</td>
                  <td className="px-5 py-3 text-gray-600">
                    {(() => {
                      const t = teachers.find(t => t.id === cls.form_teacher_id);
                      return t ? teacherName(t) : '—';
                    })()}
                  </td>
                  <td className="px-5 py-3 text-right space-x-3">
                    <button onClick={() => setFormTarget({ cls })} className="text-sm font-medium text-slate-700 hover:text-slate-900">Edit</button>
                    <button onClick={() => setDeleteTarget(cls)} className="text-sm font-medium text-red-600 hover:text-red-800">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {formTarget && (
        <ClassFormModal schoolId={schoolId} cls={formTarget.cls} teachers={teachers} onClose={() => setFormTarget(null)} onSaved={handleSaved} />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          title="Delete Class"
          confirmLabel="Yes, Delete"
          confirming={deleting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
          body={
            <p>
              Are you sure you want to delete <span className="font-medium">{deleteTarget.name}</span>? This cannot be undone.
              Classes with enrolled students or teacher assignments cannot be deleted.
            </p>
          }
        />
      )}
    </div>
  );
}

// ── Subjects tab ───────────────────────────────────────────────────────────────

const subjectFormSchema = z.object({
  name: z.string().min(1, 'Subject name is required').max(255),
  code: z.string().min(1, 'Subject code is required').max(20),
});

type SubjectForm = z.infer<typeof subjectFormSchema>;

function SubjectFormModal({ schoolId, subject, onClose, onSaved }: {
  schoolId: string;
  subject: SubjectRow | null;
  onClose: () => void;
  onSaved: (subject: SubjectRow, isNew: boolean) => void;
}) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<SubjectForm>({
    resolver: zodResolver(subjectFormSchema),
    defaultValues: { name: subject?.name ?? '', code: subject?.code ?? '' },
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: SubjectForm) {
    setApiError('');
    const payload = { name: values.name, code: values.code };
    try {
      const res = subject
        ? await apiFetch<{ success: boolean; data: SubjectRow }>(`/api/schools/${schoolId}/subjects/${subject.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await apiFetch<{ success: boolean; data: SubjectRow }>(`/api/schools/${schoolId}/subjects`, { method: 'POST', body: JSON.stringify(payload) });
      onSaved(res.data, !subject);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to save subject');
    }
  }

  return (
    <Modal title={subject ? 'Edit Subject' : 'Add Subject'} onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Field label="Subject name" error={errors.name?.message}>
          <input {...register('name')} className={inputClass} placeholder="Mathematics" />
        </Field>
        <Field label="Subject code" error={errors.code?.message}>
          <input {...register('code')} className={inputClass} placeholder="MATH" style={{ textTransform: 'uppercase' }} />
        </Field>

        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Saving…' : subject ? 'Save Changes' : 'Add Subject'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SubjectsTab({ schoolId, show }: { schoolId: string; show: ToastFn }) {
  const [loading, setLoading] = useState(true);
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [formTarget, setFormTarget] = useState<{ subject: SubjectRow | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SubjectRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<{ success: boolean; data: SubjectRow[] }>(`/api/schools/${schoolId}/subjects`)
      .then(({ data }) => setSubjects(data))
      .catch(() => show('Failed to load subjects', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  function handleSaved(subject: SubjectRow, isNew: boolean) {
    setFormTarget(null);
    setSubjects(prev => (isNew ? [...prev, subject].sort((a, b) => a.name.localeCompare(b.name)) : prev.map(s => (s.id === subject.id ? subject : s))));
    show(isNew ? 'Subject added' : 'Subject updated');
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/subjects/${deleteTarget.id}`, { method: 'DELETE' });
      setSubjects(prev => prev.filter(s => s.id !== deleteTarget.id));
      show('Subject deleted');
      setDeleteTarget(null);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to delete subject', 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <p className="text-sm text-gray-500">Subjects are taught by teachers and assessed against students per term.</p>
        <button
          onClick={() => setFormTarget({ subject: null })}
          className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 transition-colors flex items-center gap-1.5 self-start sm:self-auto shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Subject
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading subjects…</p>
      ) : subjects.length === 0 ? (
        <p className="text-sm text-gray-500">No subjects have been created yet.</p>
      ) : (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-5 py-2.5 font-medium">Name</th>
                <th className="text-left px-5 py-2.5 font-medium">Code</th>
                <th className="text-left px-5 py-2.5 font-medium">Status</th>
                <th className="text-right px-5 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {subjects.map(subject => (
                <tr key={subject.id}>
                  <td className="px-5 py-3 text-gray-900 font-medium">{subject.name}</td>
                  <td className="px-5 py-3 text-gray-600 font-mono">{subject.code}</td>
                  <td className="px-5 py-3">
                    <span className={badgeClass(subject.is_active ? 'green' : 'gray')}>{subject.is_active ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td className="px-5 py-3 text-right space-x-3">
                    <button onClick={() => setFormTarget({ subject })} className="text-sm font-medium text-slate-700 hover:text-slate-900">Edit</button>
                    <button onClick={() => setDeleteTarget(subject)} className="text-sm font-medium text-red-600 hover:text-red-800">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {formTarget && (
        <SubjectFormModal schoolId={schoolId} subject={formTarget.subject} onClose={() => setFormTarget(null)} onSaved={handleSaved} />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          title="Delete Subject"
          confirmLabel="Yes, Delete"
          confirming={deleting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
          body={
            <p>
              Are you sure you want to delete <span className="font-medium">{deleteTarget.name} ({deleteTarget.code})</span>? This cannot be undone.
              Subjects referenced by teacher assignments, scores, or assessment configs cannot be deleted.
            </p>
          }
        />
      )}
    </div>
  );
}

// ── Teacher Assignments tab ────────────────────────────────────────────────────

const assignmentFormSchema = z.object({
  class_id:   z.string().uuid('Select a class'),
  subject_id: z.string().uuid('Select a subject'),
});

type AssignmentForm = z.infer<typeof assignmentFormSchema>;

function AssignmentFormModal({ schoolId, teacher, classes, subjects, existing, onClose, onSaved }: {
  schoolId: string;
  teacher: TeacherOption;
  classes: ClassRow[];
  subjects: SubjectRow[];
  existing: AssignmentDetail[];
  onClose: () => void;
  onSaved: (assignment: AssignmentDetail) => void;
}) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<AssignmentForm>({
    resolver: zodResolver(assignmentFormSchema),
    defaultValues: { class_id: '', subject_id: '' },
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: AssignmentForm) {
    setApiError('');
    try {
      const res = await apiFetch<{ success: boolean; data: { id: string; teacher_id: string; class_id: string; subject_id: string; term_id: string; school_id: string } }>(
        `/api/schools/${schoolId}/teacher-assignments`,
        { method: 'POST', body: JSON.stringify({ teacher_id: teacher.id, class_id: values.class_id, subject_id: values.subject_id }) }
      );
      const cls = classes.find(c => c.id === values.class_id);
      const subject = subjects.find(s => s.id === values.subject_id);
      onSaved({
        ...res.data,
        class_name: cls?.name ?? '',
        class_level: cls?.level ?? '',
        class_stream: cls?.stream ?? null,
        subject_name: subject?.name ?? '',
        subject_code: subject?.code ?? '',
      });
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to create assignment');
    }
  }

  return (
    <Modal title={`Assign ${teacherName(teacher)}`} onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <p className="text-sm text-gray-500">Assign this teacher to a class and subject for the current term.</p>

        <Field label="Class" error={errors.class_id?.message}>
          <select {...register('class_id')} className={inputClass} defaultValue="">
            <option value="" disabled>Select a class…</option>
            {classes.map(c => <option key={c.id} value={c.id}>{c.name} ({c.level})</option>)}
          </select>
        </Field>

        <Field label="Subject" error={errors.subject_id?.message}>
          <select {...register('subject_id')} className={inputClass} defaultValue="">
            <option value="" disabled>Select a subject…</option>
            {subjects.map(s => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select>
        </Field>

        {existing.length > 0 && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-2.5">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">Current assignments this term</p>
            <ul className="text-sm text-gray-600 space-y-0.5">
              {existing.map(a => <li key={a.id}>{a.subject_name} — {a.class_name}{a.class_stream ? ` (${a.class_stream})` : ''}</li>)}
            </ul>
          </div>
        )}

        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Assigning…' : 'Add Assignment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AssignmentsTab({ schoolId, show }: { schoolId: string; show: ToastFn }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [teacherId, setTeacherId] = useState<string | null>(null);

  const [assignments, setAssignments] = useState<AssignmentDetail[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);

  const [assignOpen, setAssignOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssignmentDetail | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([
      apiFetch<{ success: boolean; data: { users: TeacherOption[]; total: number } }>(`/api/schools/${schoolId}/users?role=teacher&limit=100`),
      apiFetch<{ success: boolean; data: ClassRow[] }>(`/api/schools/${schoolId}/classes`),
      apiFetch<{ success: boolean; data: SubjectRow[] }>(`/api/schools/${schoolId}/subjects`),
    ])
      .then(([teachersRes, classesRes, subjectsRes]) => {
        if (cancelled) return;
        setTeachers(teachersRes.data.users);
        setClasses(classesRes.data);
        setSubjects(subjectsRes.data);
        setTeacherId(prev => prev ?? (teachersRes.data.users[0]?.id ?? null));
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load assignment data'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId]);

  const loadAssignments = useCallback(() => {
    if (!schoolId || !teacherId) return;
    setAssignmentsLoading(true);
    apiFetch<{ success: boolean; data: { teacher_mode: string; assignments: AssignmentDetail[] } }>(
      `/api/schools/${schoolId}/teachers/${teacherId}/assignments`
    )
      .then(({ data }) => setAssignments(data.assignments))
      .catch(() => show('Failed to load assignments for this teacher', 'error'))
      .finally(() => setAssignmentsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, teacherId]);

  useEffect(() => { loadAssignments(); }, [loadAssignments]);

  const selectedTeacher = teachers.find(t => t.id === teacherId) ?? null;

  function handleAssigned(assignment: AssignmentDetail) {
    setAssignOpen(false);
    setAssignments(prev => [...prev, assignment].sort((a, b) => a.class_level.localeCompare(b.class_level) || a.class_name.localeCompare(b.class_name) || a.subject_name.localeCompare(b.subject_name)));
    show('Assignment created');
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/teacher-assignments/${deleteTarget.id}`, { method: 'DELETE' });
      setAssignments(prev => prev.filter(a => a.id !== deleteTarget.id));
      show('Assignment removed');
      setDeleteTarget(null);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to remove assignment', 'error');
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading teachers…</p>;
  if (error) return <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>;
  if (teachers.length === 0) return <p className="text-sm text-gray-500">No teacher accounts have been created for this school yet.</p>;

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">Assign a teacher to a class and subject for the current term, or remove an existing assignment.</p>

      <div className="mb-5 max-w-xs">
        <label className="block text-sm font-medium text-gray-700 mb-1">Teacher</label>
        <select
          value={teacherId ?? ''}
          onChange={e => setTeacherId(e.target.value || null)}
          className={inputClass}
        >
          {teachers.map(t => <option key={t.id} value={t.id}>{teacherName(t)}</option>)}
        </select>
      </div>

      {selectedTeacher && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Assignments for {teacherName(selectedTeacher)} (current term)</h3>
            <button
              onClick={() => setAssignOpen(true)}
              disabled={classes.length === 0 || subjects.length === 0}
              className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Add Assignment
            </button>
          </div>

          {assignmentsLoading ? (
            <p className="px-5 py-4 text-sm text-gray-500">Loading assignments…</p>
          ) : assignments.length === 0 ? (
            <p className="px-5 py-4 text-sm text-gray-500">No class or subject assignments for the current term.</p>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-5 py-2.5 font-medium">Class</th>
                  <th className="text-left px-5 py-2.5 font-medium">Subject</th>
                  <th className="text-right px-5 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {assignments.map(a => (
                  <tr key={a.id}>
                    <td className="px-5 py-3 text-gray-900 font-medium">{a.class_name} ({a.class_level}{a.class_stream ? ` — ${a.class_stream}` : ''})</td>
                    <td className="px-5 py-3 text-gray-600">{a.subject_name} ({a.subject_code})</td>
                    <td className="px-5 py-3 text-right">
                      <button onClick={() => setDeleteTarget(a)} className="text-sm font-medium text-red-600 hover:text-red-800">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      {assignOpen && selectedTeacher && (
        <AssignmentFormModal
          schoolId={schoolId}
          teacher={selectedTeacher}
          classes={classes}
          subjects={subjects}
          existing={assignments}
          onClose={() => setAssignOpen(false)}
          onSaved={handleAssigned}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          title="Remove Assignment"
          confirmLabel="Yes, Remove"
          confirming={deleting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
          body={
            <p>
              Remove <span className="font-medium">{selectedTeacher ? teacherName(selectedTeacher) : 'this teacher'}</span>&rsquo;s
              assignment to <span className="font-medium">{deleteTarget.subject_name}</span> for{' '}
              <span className="font-medium">{deleteTarget.class_name}</span>? Assignments with scores already entered cannot be removed.
            </p>
          }
        />
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RosterPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();
  const [tab, setTab] = useState<Tab>('classes');

  if (!schoolId) {
    return <div className="max-w-5xl mx-auto p-8"><p className="text-sm text-gray-500">Loading roster…</p></div>;
  }

  return (
    <div className="max-w-5xl mx-auto p-8">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <h1 className="text-xl font-semibold text-gray-900 mb-1">Roster Management</h1>
      <p className="text-sm text-gray-500 mb-6">Manage classes, subjects, and teacher-to-class-and-subject assignments.</p>

      <div className="flex items-center gap-1 border-b border-gray-200 mb-6">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id ? 'border-slate-800 text-slate-900' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'classes' && <ClassesTab schoolId={schoolId} show={show} />}
      {tab === 'subjects' && <SubjectsTab schoolId={schoolId} show={show} />}
      {tab === 'assignments' && <AssignmentsTab schoolId={schoolId} show={show} />}
    </div>
  );
}
