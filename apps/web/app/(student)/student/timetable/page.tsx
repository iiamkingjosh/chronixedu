'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface DashboardData {
  student: { class_id: string | null; class_name: string | null };
}

const DAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
];

const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudentTimetablePage() {
  const { schoolId } = useAuth();

  const [className, setClassName] = useState<string | null>(null);
  const [slots, setSlots] = useState<ClassTimetableSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!schoolId) {
      setError('No school is associated with your account.');
      setLoading(false);
      return;
    }
    let cancelled = false;

    apiFetch<{ success: boolean; data: DashboardData }>(`/api/schools/${schoolId}/student/dashboard`)
      .then(({ data }) => {
        if (cancelled) return;
        setClassName(data.student.class_name);
        if (!data.student.class_id) {
          setLoading(false);
          return;
        }
        return apiFetch<{ success: boolean; data: ClassTimetableSlot[] }>(
          `/api/schools/${schoolId}/timetable/class/${data.student.class_id}`
        ).then((res) => {
          if (!cancelled) setSlots(res.data);
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load timetable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId]);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <p className="text-sm text-gray-500 py-10 text-center">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  function slotAt(day: number, period: number): ClassTimetableSlot | undefined {
    return slots.find((s) => s.day_of_week === day && s.period_number === period);
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Timetable</h1>
        <p className="text-sm text-gray-500">{className ?? 'No class assigned'}</p>
      </div>

      {slots.length === 0 ? (
        <p className="text-sm text-gray-500 py-10 text-center">No timetable has been set up yet.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs font-medium uppercase tracking-wide text-gray-400">
                <th className="px-3 py-3 text-left whitespace-nowrap">Period</th>
                {DAYS.map((d) => (
                  <th key={d.value} className="px-3 py-3 text-left whitespace-nowrap">{d.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {PERIODS.map((period) => (
                <tr key={period}>
                  <td className="px-3 py-3 text-xs font-medium text-gray-500">{period}</td>
                  {DAYS.map((d) => {
                    const slot = slotAt(d.value, period);
                    return (
                      <td key={d.value} className="px-3 py-3 align-top">
                        {slot ? (
                          <div>
                            <p className="text-xs font-semibold text-gray-900">{slot.subject_code}</p>
                            <p className="text-xs text-gray-500">{slot.teacher_name}</p>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
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
