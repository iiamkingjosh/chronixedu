'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassOption {
  id: string;
  name: string;
  level: string;
  stream: string | null;
}

interface SubjectOption {
  id: string;
  name: string;
  code: string;
  is_active: boolean;
}

interface TeacherOption {
  id: string;
  first_name: string;
  last_name: string;
}

interface ClassTimetableSlot {
  id: string;
  day_of_week: number;
  period_number: number;
  subject_id: string;
  subject_name: string;
  subject_code: string;
  teacher_id: string;
  teacher_name: string;
}

type Toast = { message: string; type: 'success' | 'error' } | null;

const DAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
];

const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8];

function classLabel(c: ClassOption): string {
  return c.stream ? `${c.name} (${c.stream})` : c.name;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PrincipalTimetablePage() {
  const { schoolId } = useAuth();

  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [termId, setTermId] = useState<string | null>(null);

  const [classId, setClassId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [slots, setSlots] = useState<ClassTimetableSlot[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<Toast>(null);

  function showToast(message: string, type: 'success' | 'error' = 'success') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }

  useEffect(() => {
    if (!schoolId) {
      setError('No school is associated with your account.');
      setLoading(false);
      return;
    }
    let cancelled = false;

    Promise.all([
      apiFetch<{ success: boolean; data: ClassOption[] }>(`/api/schools/${schoolId}/classes`),
      apiFetch<{ success: boolean; data: SubjectOption[] }>(`/api/schools/${schoolId}/subjects`),
      apiFetch<{ success: boolean; data: { users: TeacherOption[] } }>(`/api/schools/${schoolId}/users?role=teacher&limit=100`),
      apiFetch<{ success: boolean; data: { term: { id: string } | null } }>(`/api/schools/${schoolId}/current-context`),
    ])
      .then(([classesRes, subjectsRes, teachersRes, contextRes]) => {
        if (cancelled) return;
        setClasses(classesRes.data);
        setSubjects(subjectsRes.data);
        setTeachers(teachersRes.data.users);
        setTermId(contextRes.data.term?.id ?? null);
        if (classesRes.data.length) setClassId(classesRes.data[0].id);
        if (subjectsRes.data.length) setSubjectId(subjectsRes.data[0].id);
        if (teachersRes.data.users.length) setTeacherId(teachersRes.data.users[0].id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load timetable data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId]);

  const loadSlots = useCallback(() => {
    if (!schoolId || !classId || !termId) return;
    apiFetch<{ success: boolean; data: ClassTimetableSlot[] }>(
      `/api/schools/${schoolId}/timetable/class/${classId}?term_id=${termId}`
    )
      .then((res) => setSlots(res.data))
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : 'Failed to load timetable', 'error'));
  }, [schoolId, classId, termId]);

  useEffect(() => { loadSlots(); }, [loadSlots]);

  function slotAt(day: number, period: number): ClassTimetableSlot | undefined {
    return slots.find((s) => s.day_of_week === day && s.period_number === period);
  }

  async function handleDrop(day: number, period: number) {
    if (!schoolId || !classId || !termId || !subjectId || !teacherId) return;
    try {
      await apiFetch(`/api/schools/${schoolId}/timetable`, {
        method: 'POST',
        body: JSON.stringify({
          class_id: classId,
          term_id: termId,
          day_of_week: day,
          period_number: period,
          subject_id: subjectId,
          teacher_id: teacherId,
        }),
      });
      showToast('Slot added');
      loadSlots();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to add slot', 'error');
    }
  }

  async function handleRemove(slotId: string) {
    if (!schoolId) return;
    try {
      await apiFetch(`/api/schools/${schoolId}/timetable/${slotId}`, { method: 'DELETE' });
      showToast('Slot removed');
      loadSlots();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to remove slot', 'error');
    }
  }

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-500">Loading timetable…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  const selectedSubject = subjects.find((s) => s.id === subjectId);
  const selectedTeacher = teachers.find((t) => t.id === teacherId);
  const composerReady = Boolean(selectedSubject && selectedTeacher && termId);
  const composerLabel = selectedSubject && selectedTeacher
    ? `${selectedSubject.code} — ${selectedTeacher.first_name} ${selectedTeacher.last_name}`
    : 'Select subject and teacher';

  return (
    <div className="max-w-5xl mx-auto p-8">
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
            toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
          }`}
        >
          {toast.message}
        </div>
      )}

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Timetable Builder</h1>
        <p className="text-sm text-gray-500 mt-1">
          Pick a subject and teacher, then drag the pill onto an empty period to schedule it.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4 mb-6">
        <label className="flex flex-col text-sm">
          <span className="text-gray-600 mb-1">Class</span>
          <select
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{classLabel(c)}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col text-sm">
          <span className="text-gray-600 mb-1">Subject</span>
          <select
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col text-sm">
          <span className="text-gray-600 mb-1">Teacher</span>
          <select
            value={teacherId}
            onChange={(e) => setTeacherId(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>{t.first_name} {t.last_name}</option>
            ))}
          </select>
        </label>

        <div
          draggable={composerReady}
          onDragStart={(e) => e.dataTransfer.setData('text/plain', 'slot')}
          className={`select-none rounded-lg border px-3 py-2 text-sm font-medium ${
            composerReady
              ? 'cursor-grab border-[#003366] bg-[#003366]/5 text-[#003366]'
              : 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
          }`}
        >
          {composerLabel}
        </div>
      </div>

      {!termId ? (
        <p className="text-sm text-gray-500">No active academic term, so the timetable cannot be edited yet.</p>
      ) : !classes.length ? (
        <p className="text-sm text-gray-500">No classes found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border border-gray-200 bg-gray-50 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Period</th>
                {DAYS.map((d) => (
                  <th key={d.value} className="border border-gray-200 bg-gray-50 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    {d.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERIODS.map((period) => (
                <tr key={period}>
                  <td className="border border-gray-200 px-3 py-2 text-xs font-medium text-gray-500">{period}</td>
                  {DAYS.map((d) => {
                    const slot = slotAt(d.value, period);
                    return (
                      <td
                        key={d.value}
                        onDragOver={(e) => { if (!slot) e.preventDefault(); }}
                        onDrop={(e) => { e.preventDefault(); if (!slot) handleDrop(d.value, period); }}
                        className={`border border-gray-200 px-2 py-2 align-top ${slot ? 'bg-white' : 'bg-gray-50/50'}`}
                      >
                        {slot ? (
                          <div className="rounded-md border border-[#003366]/20 bg-[#003366]/5 px-2 py-1">
                            <div className="flex items-start justify-between gap-1">
                              <div>
                                <p className="text-xs font-semibold text-[#003366]">{slot.subject_code}</p>
                                <p className="text-xs text-gray-500">{slot.teacher_name}</p>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleRemove(slot.id)}
                                className="text-gray-400 hover:text-red-600 text-xs leading-none"
                                aria-label="Remove slot"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-300">Drop here</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
