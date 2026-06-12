'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TeacherTimetableSlot {
  id: string;
  day_of_week: number;
  period_number: number;
  class_id: string;
  class_name: string;
  subject_id: string;
  subject_name: string;
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

export default function TeacherTimetablePage() {
  const { schoolId, user } = useAuth();

  const [slots, setSlots] = useState<TeacherTimetableSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!schoolId || !user) {
      setError('No school is associated with your account.');
      setLoading(false);
      return;
    }
    let cancelled = false;

    apiFetch<{ success: boolean; data: TeacherTimetableSlot[] }>(
      `/api/schools/${schoolId}/timetable/teacher/${user.user_id}`
    )
      .then((res) => {
        if (!cancelled) setSlots(res.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load timetable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId, user]);

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

  function slotAt(day: number, period: number): TeacherTimetableSlot | undefined {
    return slots.find((s) => s.day_of_week === day && s.period_number === period);
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">My Timetable</h1>
        <p className="text-sm text-gray-500 mt-1">Your weekly teaching schedule.</p>
      </div>

      {slots.length === 0 ? (
        <p className="text-sm text-gray-500">No active academic term, or no periods have been assigned to you yet.</p>
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
                      <td key={d.value} className="border border-gray-200 px-2 py-2 align-top">
                        {slot ? (
                          <div className="rounded-md border border-[#003366]/20 bg-[#003366]/5 px-2 py-1">
                            <p className="text-xs font-semibold text-[#003366]">{slot.class_name}</p>
                            <p className="text-xs text-gray-500">{slot.subject_name}</p>
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
