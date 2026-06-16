'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentListRow {
  id: string;
  school_id: string;
  user_id: string;
  admission_no: string;
  dob: string | null;
  gender: string | null;
  address: string | null;
  photo_url: string | null;
  blood_group: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  first_name: string;
  last_name: string;
  email: string;
  class_name: string | null;
  class_level: string | null;
}

interface ClassRow {
  id: string;
  school_id: string;
  name: string;
  level: string;
  stream: string | null;
}

interface NewParentRow {
  email: string;
  temp_password: string;
}

interface RegistrationResult {
  student: { id: string; admission_no: string; email: string };
  admission_no: string;
  temp_password: string;
  enrollment: unknown;
  new_parents: NewParentRow[];
}

const PAGE_SIZE = 20;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

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

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className={`modal-panel bg-white rounded-xl shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'}`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="font-heading text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors duration-200">
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

const inputClass = 'input-field';

function fullName(row: StudentListRow): string {
  return `${row.first_name} ${row.last_name}`;
}

// ── Registration form ──────────────────────────────────────────────────────────

const parentFormSchema = z.object({
  email:              z.string().email('Enter a valid email'),
  first_name:         z.string().min(1, 'Required').max(100),
  last_name:          z.string().min(1, 'Required').max(100),
  phone:              z.string().max(30).optional().or(z.literal('')),
  relationship_type:  z.string().min(1, 'Required').max(50),
  is_primary_contact: z.boolean().optional(),
});

const registrationFormSchema = z.object({
  first_name:               z.string().min(1, 'First name is required').max(100),
  last_name:                z.string().min(1, 'Last name is required').max(100),
  email:                    z.string().email('Enter a valid email').optional().or(z.literal('')),
  phone:                    z.string().max(30).optional().or(z.literal('')),
  dob:                      z.string().regex(datePattern, 'Use YYYY-MM-DD').optional().or(z.literal('')),
  gender:                   z.string().max(50).optional().or(z.literal('')),
  address:                  z.string().max(500).optional().or(z.literal('')),
  blood_group:              z.string().max(20).optional().or(z.literal('')),
  emergency_contact_name:   z.string().max(200).optional().or(z.literal('')),
  emergency_contact_phone:  z.string().max(30).optional().or(z.literal('')),
  class_id:                 z.string().optional().or(z.literal('')),
  parents:                  z.array(parentFormSchema),
});

type RegistrationForm = z.infer<typeof registrationFormSchema>;

const STEP_FIELDS: Record<number, (keyof RegistrationForm)[]> = {
  1: ['first_name', 'last_name', 'email', 'phone', 'dob', 'gender', 'address', 'blood_group', 'emergency_contact_name', 'emergency_contact_phone'],
  2: ['class_id'],
  3: ['parents'],
};

const STEP_LABELS = ['Student Details', 'Class Assignment', 'Parents / Guardians'];

function RegisterStudentModal({ schoolId, classes, onClose, onRegistered }: {
  schoolId: string;
  classes: ClassRow[];
  onClose: () => void;
  onRegistered: (result: RegistrationResult) => void;
}) {
  const [step, setStep] = useState(1);
  const [apiError, setApiError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { register, handleSubmit, control, trigger, formState: { errors } } = useForm<RegistrationForm>({
    resolver: zodResolver(registrationFormSchema),
    defaultValues: {
      first_name: '', last_name: '', email: '', phone: '', dob: '', gender: '', address: '',
      blood_group: '', emergency_contact_name: '', emergency_contact_phone: '', class_id: '',
      parents: [],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'parents' });

  async function goNext() {
    const valid = await trigger(STEP_FIELDS[step]);
    if (valid) setStep(s => Math.min(3, s + 1));
  }

  function goBack() {
    setStep(s => Math.max(1, s - 1));
  }

  async function onSubmit(values: RegistrationForm) {
    setApiError('');
    setSubmitting(true);
    const payload = {
      first_name: values.first_name,
      last_name: values.last_name,
      ...(values.email ? { email: values.email } : {}),
      ...(values.phone ? { phone: values.phone } : {}),
      dob: values.dob || null,
      gender: values.gender || null,
      address: values.address || null,
      blood_group: values.blood_group || null,
      emergency_contact_name: values.emergency_contact_name || null,
      emergency_contact_phone: values.emergency_contact_phone || null,
      class_id: values.class_id || null,
      parents: values.parents.map(p => ({
        email: p.email,
        first_name: p.first_name,
        last_name: p.last_name,
        ...(p.phone ? { phone: p.phone } : {}),
        relationship_type: p.relationship_type,
        is_primary_contact: p.is_primary_contact ?? false,
      })),
    };
    try {
      const res = await apiFetch<{ success: boolean; data: RegistrationResult }>(`/api/schools/${schoolId}/students`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      onRegistered(res.data);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to register student');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Register Student" onClose={onClose} wide>
      <div className="flex items-center gap-2 mb-6">
        {STEP_LABELS.map((label, idx) => {
          const n = idx + 1;
          return (
            <div key={label} className="flex items-center gap-2 flex-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition-colors duration-200 ${
                step === n ? 'bg-[#003366] text-white' : step > n ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
              }`}>
                {step > n ? '✓' : n}
              </div>
              <span className={`text-xs font-medium ${step === n ? 'text-gray-900' : 'text-gray-400'}`}>{label}</span>
              {n < STEP_LABELS.length && <div className="flex-1 h-px bg-gray-200" />}
            </div>
          );
        })}
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {step === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="First name" error={errors.first_name?.message}>
                <input {...register('first_name')} className={inputClass} />
              </Field>
              <Field label="Last name" error={errors.last_name?.message}>
                <input {...register('last_name')} className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Email (optional)" error={errors.email?.message}>
                <input {...register('email')} type="email" className={inputClass} />
              </Field>
              <Field label="Phone (optional)" error={errors.phone?.message}>
                <input {...register('phone')} className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Date of birth (optional)" error={errors.dob?.message}>
                <input {...register('dob')} type="date" className={inputClass} />
              </Field>
              <Field label="Gender (optional)" error={errors.gender?.message}>
                <select {...register('gender')} className={inputClass} defaultValue="">
                  <option value="">Select…</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              </Field>
            </div>
            <Field label="Address (optional)" error={errors.address?.message}>
              <textarea {...register('address')} rows={2} className={inputClass} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Blood group (optional)" error={errors.blood_group?.message}>
                <input {...register('blood_group')} className={inputClass} placeholder="O+" />
              </Field>
              <Field label="Emergency contact name (optional)" error={errors.emergency_contact_name?.message}>
                <input {...register('emergency_contact_name')} className={inputClass} />
              </Field>
            </div>
            <Field label="Emergency contact phone (optional)" error={errors.emergency_contact_phone?.message}>
              <input {...register('emergency_contact_phone')} className={inputClass} />
            </Field>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-gray-500">Optionally enroll the student into a class right away. You can also assign a class later.</p>
            <Field label="Class (optional)" error={errors.class_id?.message}>
              <select {...register('class_id')} className={inputClass} defaultValue="">
                <option value="">No class — assign later</option>
                {classes.map(c => <option key={c.id} value={c.id}>{c.name} ({c.level}{c.stream ? ` — ${c.stream}` : ''})</option>)}
              </select>
            </Field>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">Optionally add parent or guardian accounts. Each will receive a login.</p>
              <button
                type="button"
                onClick={() => append({ email: '', first_name: '', last_name: '', phone: '', relationship_type: '', is_primary_contact: fields.length === 0 })}
                className="btn-primary !px-3 !py-1.5 text-xs"
              >
                Add Parent / Guardian
              </button>
            </div>

            {fields.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No parents or guardians added.</p>
            ) : (
              <div className="space-y-4">
                {fields.map((field, idx) => (
                  <div key={field.id} className="border border-gray-200 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-gray-700">Parent / Guardian {idx + 1}</p>
                      <button type="button" onClick={() => remove(idx)} className="text-xs font-medium text-red-600 hover:text-red-800 transition-colors duration-200">Remove</button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Field label="First name" error={errors.parents?.[idx]?.first_name?.message}>
                        <input {...register(`parents.${idx}.first_name`)} className={inputClass} />
                      </Field>
                      <Field label="Last name" error={errors.parents?.[idx]?.last_name?.message}>
                        <input {...register(`parents.${idx}.last_name`)} className={inputClass} />
                      </Field>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Field label="Email" error={errors.parents?.[idx]?.email?.message}>
                        <input {...register(`parents.${idx}.email`)} type="email" className={inputClass} />
                      </Field>
                      <Field label="Phone (optional)" error={errors.parents?.[idx]?.phone?.message}>
                        <input {...register(`parents.${idx}.phone`)} className={inputClass} />
                      </Field>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                      <Field label="Relationship" error={errors.parents?.[idx]?.relationship_type?.message}>
                        <input {...register(`parents.${idx}.relationship_type`)} className={inputClass} placeholder="Father, Mother, Guardian…" />
                      </Field>
                      <label className="flex items-center gap-2 text-sm text-gray-700 mb-2">
                        <input type="checkbox" {...register(`parents.${idx}.is_primary_contact`)} className="rounded border-gray-300" />
                        Primary contact
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}

        <div className="flex justify-between pt-2">
          <button type="button" onClick={step === 1 ? onClose : goBack} className="btn-ghost">
            {step === 1 ? 'Cancel' : 'Back'}
          </button>
          {step < 3 ? (
            <button type="button" onClick={goNext} className="btn-primary !px-5">
              Continue
            </button>
          ) : (
            <button type="submit" disabled={submitting} className="btn-primary !px-5">
              {submitting ? 'Registering…' : 'Register Student'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudentRegistrationPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  const [students, setStudents] = useState<StudentListRow[]>([]);
  const [meta, setMeta] = useState<{ total: number; page: number; limit: number; pages: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [credentials, setCredentials] = useState<{ admission_no: string; email: string; temp_password: string; new_parents: NewParentRow[] } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const loadStudents = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
    apiFetch<{ success: boolean; data: StudentListRow[]; meta: { total: number; page: number; limit: number; pages: number } }>(
      `/api/schools/${schoolId}/students?${params.toString()}`
    )
      .then(({ data, meta }) => { setStudents(data); setMeta(meta); })
      .catch(() => show('Failed to load students', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, page, debouncedSearch]);

  useEffect(() => { loadStudents(); }, [loadStudents]);

  useEffect(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: ClassRow[] }>(`/api/schools/${schoolId}/classes`)
      .then(({ data }) => setClasses(data))
      .catch(() => show('Failed to load classes', 'error'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  function handleRegistered(result: RegistrationResult) {
    setRegisterOpen(false);
    setCredentials({
      admission_no: result.admission_no,
      email: result.student.email,
      temp_password: result.temp_password,
      new_parents: result.new_parents,
    });
    show('Student registered');
    setPage(1);
    loadStudents();
  }

  if (!schoolId) {
    return <div className="max-w-5xl mx-auto p-8"><p className="text-sm text-gray-500">Loading…</p></div>;
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

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <h1 className="text-xl font-semibold text-gray-900">Student Registration</h1>
        <button
          onClick={() => setRegisterOpen(true)}
          className="btn-primary gap-1.5 self-start sm:self-auto"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Register Student
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-6">Search existing students or register a new student into the school.</p>

      {credentials && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-xl px-5 py-4 flex items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-sm font-semibold text-green-800">
              Student registered (admission no. {credentials.admission_no}) — share these credentials securely:
            </p>
            <p className="text-sm text-green-700 font-mono">
              {credentials.email || '(no email set)'} &nbsp;/&nbsp; {credentials.temp_password}
            </p>
            {credentials.new_parents.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-green-800 uppercase tracking-wide mt-2 mb-1">Parent / guardian accounts created</p>
                <ul className="text-sm text-green-700 font-mono space-y-0.5">
                  {credentials.new_parents.map(p => (
                    <li key={p.email}>{p.email} / {p.temp_password}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-green-600">These temporary passwords are shown only once. Each user should change their password on first login.</p>
          </div>
          <button onClick={() => setCredentials(null)} className="text-green-500 hover:text-green-700 shrink-0 transition-colors duration-200">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className="mb-4 max-w-sm">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or admission number…"
          className={inputClass}
        />
      </div>

      {loading ? (
        <div className="card overflow-hidden">
          <div className="skeleton h-9 w-full rounded-none" />
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-6 px-5 py-3 border-t border-gray-100">
              <div className="skeleton h-4 w-20" />
              <div className="skeleton h-4 w-32" />
              <div className="skeleton h-4 w-24" />
              <div className="skeleton h-4 w-40 ml-auto" />
            </div>
          ))}
        </div>
      ) : students.length === 0 ? (
        <p className="text-sm text-gray-500">{debouncedSearch ? 'No students match your search.' : 'No students have been registered yet.'}</p>
      ) : (
        <>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-5 py-2.5 font-medium">Admission No.</th>
                  <th className="text-left px-5 py-2.5 font-medium">Name</th>
                  <th className="text-left px-5 py-2.5 font-medium">Class</th>
                  <th className="text-left px-5 py-2.5 font-medium">Email</th>
                  <th className="text-right px-5 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {students.map(s => (
                  <tr key={s.id} className="table-row-hover">
                    <td className="px-5 py-3 text-gray-900 font-mono">{s.admission_no}</td>
                    <td className="px-5 py-3 text-gray-900 font-medium">{fullName(s)}</td>
                    <td className="px-5 py-3 text-gray-600">{s.class_name ? `${s.class_name} (${s.class_level})` : '—'}</td>
                    <td className="px-5 py-3 text-gray-600">{s.email}</td>
                    <td className="px-5 py-3 text-right">
                      <Link href={`/registrar/students/${s.id}`} className="text-sm font-medium text-[#2472B4] hover:underline">
                        View Profile
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>

          {meta && meta.pages > 1 && (
            <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
              <span>Page {meta.page} of {meta.pages} ({meta.total} students)</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="btn-secondary !px-3 !py-1.5 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage(p => Math.min(meta.pages, p + 1))}
                  disabled={page >= meta.pages}
                  className="btn-secondary !px-3 !py-1.5 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {registerOpen && (
        <RegisterStudentModal schoolId={schoolId} classes={classes} onClose={() => setRegisterOpen(false)} onRegistered={handleRegistered} />
      )}
    </div>
  );
}
