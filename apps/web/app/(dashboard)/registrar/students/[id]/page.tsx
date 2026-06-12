'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassEnrollment {
  id: string;
  class_id: string;
  class_name: string;
  class_level: string;
  class_stream: string | null;
  session_id: string;
  session_name: string;
  enrolled_at: string;
}

interface LinkedParent {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  relationship_type: string;
  is_primary_contact: boolean;
}

interface StudentProfile {
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
  phone: string | null;
  enrollments: ClassEnrollment[];
  parents: LinkedParent[];
}

interface ClassRow {
  id: string;
  school_id: string;
  name: string;
  level: string;
  stream: string | null;
}

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

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Bio edit form ──────────────────────────────────────────────────────────────

const bioFormSchema = z.object({
  first_name:               z.string().min(1, 'Required').max(100),
  last_name:                z.string().min(1, 'Required').max(100),
  phone:                    z.string().max(30).optional().or(z.literal('')),
  dob:                      z.string().regex(datePattern, 'Use YYYY-MM-DD').optional().or(z.literal('')),
  gender:                   z.string().max(50).optional().or(z.literal('')),
  address:                  z.string().max(500).optional().or(z.literal('')),
  blood_group:              z.string().max(20).optional().or(z.literal('')),
  emergency_contact_name:   z.string().max(200).optional().or(z.literal('')),
  emergency_contact_phone:  z.string().max(30).optional().or(z.literal('')),
});

type BioForm = z.infer<typeof bioFormSchema>;

// ── Class correction modal ──────────────────────────────────────────────────────

const classCorrectionSchema = z.object({
  class_id: z.string().min(1, 'Select a class'),
  reason:   z.string().min(10, 'Reason must be at least 10 characters').max(500),
});

type ClassCorrectionForm = z.infer<typeof classCorrectionSchema>;

function ClassCorrectionModal({ schoolId, studentId, currentClassId, classes, onClose, onUpdated }: {
  schoolId: string;
  studentId: string;
  currentClassId: string | null;
  classes: ClassRow[];
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [apiError, setApiError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<ClassCorrectionForm>({
    resolver: zodResolver(classCorrectionSchema),
    defaultValues: { class_id: currentClassId ?? '', reason: '' },
  });

  async function onSubmit(values: ClassCorrectionForm) {
    setApiError('');
    setSubmitting(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/students/${studentId}/class`, {
        method: 'PATCH',
        body: JSON.stringify(values),
      });
      onUpdated();
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to update class');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Correct Class" onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <p className="text-sm text-gray-500">
          Moves this student to a different class within their current session. A reason is required for the audit log.
        </p>
        <Field label="New class" error={errors.class_id?.message}>
          <select {...register('class_id')} className={inputClass} defaultValue={currentClassId ?? ''}>
            <option value="">Select a class…</option>
            {classes.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.level}{c.stream ? ` — ${c.stream}` : ''})</option>
            ))}
          </select>
        </Field>
        <Field label="Reason for correction" error={errors.reason?.message}>
          <textarea
            {...register('reason')}
            rows={3}
            className={inputClass}
            placeholder="Explain why this student's class is being corrected (min. 10 characters)"
          />
        </Field>

        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors">
            {submitting ? 'Saving…' : 'Save Correction'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudentProfilePage() {
  const { schoolId } = useAuth();
  const params = useParams<{ id: string }>();
  const studentId = params.id;
  const { toast, show } = useToast();

  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [savingBio, setSavingBio] = useState(false);
  const [transcriptUrl, setTranscriptUrl] = useState<string | null>(null);
  const [generatingTranscript, setGeneratingTranscript] = useState(false);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<BioForm>({
    resolver: zodResolver(bioFormSchema),
    defaultValues: {
      first_name: '', last_name: '', phone: '', dob: '', gender: '', address: '',
      blood_group: '', emergency_contact_name: '', emergency_contact_phone: '',
    },
  });

  const loadProfile = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    apiFetch<{ success: boolean; data: StudentProfile }>(`/api/schools/${schoolId}/students/${studentId}`)
      .then(({ data }) => setProfile(data))
      .catch(() => show('Failed to load student profile', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, studentId]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  useEffect(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: ClassRow[] }>(`/api/schools/${schoolId}/classes`)
      .then(({ data }) => setClasses(data))
      .catch(() => show('Failed to load classes', 'error'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  useEffect(() => {
    if (!profile) return;
    reset({
      first_name: profile.first_name,
      last_name: profile.last_name,
      phone: profile.phone ?? '',
      dob: profile.dob ?? '',
      gender: profile.gender ?? '',
      address: profile.address ?? '',
      blood_group: profile.blood_group ?? '',
      emergency_contact_name: profile.emergency_contact_name ?? '',
      emergency_contact_phone: profile.emergency_contact_phone ?? '',
    });
  }, [profile, reset]);

  async function onSaveBio(values: BioForm) {
    if (!schoolId) return;
    setSavingBio(true);
    const payload = {
      first_name: values.first_name,
      last_name: values.last_name,
      phone: values.phone || '',
      dob: values.dob || null,
      gender: values.gender || null,
      address: values.address || null,
      blood_group: values.blood_group || null,
      emergency_contact_name: values.emergency_contact_name || null,
      emergency_contact_phone: values.emergency_contact_phone || null,
    };
    try {
      await apiFetch(`/api/schools/${schoolId}/students/${studentId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      show('Student profile updated');
      loadProfile();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to update profile', 'error');
    } finally {
      setSavingBio(false);
    }
  }

  async function handleGenerateTranscript() {
    if (!schoolId) return;
    setGeneratingTranscript(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { pdf_url: string } }>(
        `/api/schools/${schoolId}/students/${studentId}/transcript`,
        { method: 'POST' }
      );
      setTranscriptUrl(res.data.pdf_url);
      show('Transcript generated');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to generate transcript', 'error');
    } finally {
      setGeneratingTranscript(false);
    }
  }

  if (!schoolId || loading) {
    return <div className="max-w-4xl mx-auto p-8"><p className="text-sm text-gray-500">Loading…</p></div>;
  }

  if (!profile) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <Link href="/registrar/students" className="text-sm text-slate-600 hover:text-slate-900">&larr; Back to Students</Link>
        <p className="text-sm text-gray-500 mt-4">Student not found.</p>
      </div>
    );
  }

  // enrollments are ordered most-recent session first
  const currentEnrollment = profile.enrollments[0] ?? null;

  return (
    <div className="max-w-4xl mx-auto p-8">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <Link href="/registrar/students" className="text-sm text-slate-600 hover:text-slate-900">&larr; Back to Students</Link>

      <div className="flex items-start justify-between mt-2 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{profile.first_name} {profile.last_name}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {profile.admission_no} · {profile.email}
            {currentEnrollment && ` · ${currentEnrollment.class_name} (${currentEnrollment.class_level}${currentEnrollment.class_stream ? ` — ${currentEnrollment.class_stream}` : ''}) · ${currentEnrollment.session_name}`}
          </p>
        </div>
        <button
          onClick={() => setCorrectionOpen(true)}
          className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 transition-colors shrink-0"
        >
          Correct Class
        </button>
      </div>

      {/* Bio edit form */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Student Details</h2>
        <form onSubmit={handleSubmit(onSaveBio)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="First name" error={errors.first_name?.message}>
              <input {...register('first_name')} className={inputClass} />
            </Field>
            <Field label="Last name" error={errors.last_name?.message}>
              <input {...register('last_name')} className={inputClass} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Phone" error={errors.phone?.message}>
              <input {...register('phone')} className={inputClass} />
            </Field>
            <Field label="Date of birth" error={errors.dob?.message}>
              <input {...register('dob')} type="date" className={inputClass} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Gender" error={errors.gender?.message}>
              <select {...register('gender')} className={inputClass} defaultValue="">
                <option value="">Select…</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </Field>
            <Field label="Blood group" error={errors.blood_group?.message}>
              <input {...register('blood_group')} className={inputClass} placeholder="O+" />
            </Field>
          </div>
          <Field label="Address" error={errors.address?.message}>
            <textarea {...register('address')} rows={2} className={inputClass} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Emergency contact name" error={errors.emergency_contact_name?.message}>
              <input {...register('emergency_contact_name')} className={inputClass} />
            </Field>
            <Field label="Emergency contact phone" error={errors.emergency_contact_phone?.message}>
              <input {...register('emergency_contact_phone')} className={inputClass} />
            </Field>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={savingBio} className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors">
              {savingBio ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>

      {/* Enrollment history */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Enrollment History</h2>
        {profile.enrollments.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No enrollment records.</p>
        ) : (
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-5 py-2.5 font-medium">Session</th>
                  <th className="text-left px-5 py-2.5 font-medium">Class</th>
                  <th className="text-left px-5 py-2.5 font-medium">Enrolled</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {profile.enrollments.map(e => (
                  <tr key={e.id}>
                    <td className="px-5 py-3 text-gray-900 font-medium">{e.session_name}</td>
                    <td className="px-5 py-3 text-gray-600">{e.class_name} ({e.class_level}{e.class_stream ? ` — ${e.class_stream}` : ''})</td>
                    <td className="px-5 py-3 text-gray-600">{formatDate(e.enrolled_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Parents */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Parents / Guardians</h2>
        {profile.parents.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No linked parents or guardians.</p>
        ) : (
          <div className="space-y-3">
            {profile.parents.map(p => (
              <div key={p.id} className="flex items-center justify-between border border-gray-200 rounded-lg px-4 py-2.5">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {p.first_name} {p.last_name}
                    {p.is_primary_contact && (
                      <span className="ml-2 text-xs font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">Primary</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">{p.relationship_type}{p.phone ? ` · ${p.phone}` : ''}</p>
                </div>
                <p className="text-sm text-gray-600">{p.email}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Transcript */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Transcript</h2>
        <p className="text-sm text-gray-500 mb-4">Generate a PDF transcript covering all of this student&apos;s sessions and results.</p>
        <div className="flex items-center gap-3">
          <button
            onClick={handleGenerateTranscript}
            disabled={generatingTranscript}
            className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {generatingTranscript ? 'Generating…' : 'Generate Transcript'}
          </button>
          {transcriptUrl && (
            <a href={transcriptUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-slate-700 hover:text-slate-900 underline">
              View PDF
            </a>
          )}
        </div>
      </div>

      {correctionOpen && (
        <ClassCorrectionModal
          schoolId={schoolId}
          studentId={studentId}
          currentClassId={currentEnrollment?.class_id ?? null}
          classes={classes}
          onClose={() => setCorrectionOpen(false)}
          onUpdated={() => {
            setCorrectionOpen(false);
            show('Class updated');
            loadProfile();
          }}
        />
      )}
    </div>
  );
}
