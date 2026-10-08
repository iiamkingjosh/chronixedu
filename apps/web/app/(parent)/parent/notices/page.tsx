'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { useParentContext } from '@/lib/parentContext';
import { apiFetch } from '@/lib/api';
import AnnouncementsView from '@/components/announcements/AnnouncementsView';

interface ClassNotice {
  id: string;
  title: string;
  body: string;
  created_at: string;
}

/**
 * The selected child's class notices, then the school's announcements. A parent saw announcements
 * only; what a teacher posted to the class reached the students and never home (Moses, 8 Oct 2026).
 */
function ClassNotices() {
  const { schoolId } = useAuth();
  const { selectedChild } = useParentContext();
  const [notices, setNotices] = useState<ClassNotice[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!schoolId || !selectedChild) return;
    let cancelled = false;
    setNotices(null);
    setError('');
    apiFetch<{ success: boolean; data: ClassNotice[] }>(`/api/schools/${schoolId}/parent/students/${selectedChild.student_id}/notices`)
      .then(({ data }) => { if (!cancelled) setNotices(data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load class notices'); });
    return () => { cancelled = true; };
  }, [schoolId, selectedChild]);

  if (!selectedChild) return null;

  return (
    <section className="max-w-3xl mx-auto p-4">
      <h2 className="text-base font-semibold text-gray-900">
        Class notices{selectedChild.class_name ? ` · ${selectedChild.class_name}` : ''}
      </h2>
      <p className="text-sm text-gray-500 mb-3">What {selectedChild.first_name}&apos;s teachers have posted to the class.</p>
      {error && <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>}
      {!error && notices === null && <p className="text-sm text-gray-500">Loading…</p>}
      {notices && notices.length === 0 && (
        <p className="text-sm text-gray-500">No class notices{selectedChild.class_name ? '' : ': ' + selectedChild.first_name + ' has no class this session'}.</p>
      )}
      {notices && notices.length > 0 && (
        <ul className="space-y-3">
          {notices.map(n => (
            <li key={n.id} className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-sm font-medium text-gray-900">{n.title}</p>
              <p className="text-sm text-gray-700 whitespace-pre-line mt-1">{n.body}</p>
              <p className="text-xs text-gray-400 mt-2">{new Date(n.created_at).toLocaleDateString()}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function ParentNoticesPage() {
  return (
    <>
      <ClassNotices />
      <AnnouncementsView />
    </>
  );
}
