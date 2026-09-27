'use client';

/**
 * The principal's remark for this student's current term.
 *
 * The report card template has always rendered this field and the report-card service has
 * always read it — but nothing could write it, so every report card issued carried an
 * empty principal's remark beside a form-teacher comment that worked. This is the input
 * that was missing.
 *
 * Lives on the student profile because that is where a principal already works per
 * student, and that page is shared with the registrar — so, like the academic columns on
 * the students list, this renders only for the roles the API will accept. A registrar
 * seeing a box that 403s on save is worse than not seeing the box.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

const MAX_LENGTH = 1000;

interface RemarkData {
  remark_text: string | null;
  term_id: string;
  term_name: string;
}

export default function PrincipalRemarkCard({
  schoolId,
  studentId,
  studentName,
}: {
  schoolId: string;
  studentId: string;
  studentName: string;
}) {
  const [data, setData] = useState<RemarkData | null>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [noTerm, setNoTerm] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: RemarkData }>(
      `/api/schools/${schoolId}/principal-remarks/${studentId}`
    )
      .then(({ data: d }) => { setData(d); setText(d.remark_text ?? ''); setNoTerm(false); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to load the remark';
        // A school between terms is a normal state, not an error to shout about — the
        // registrar uses this page year-round.
        if (message.toLowerCase().includes('active term')) setNoTerm(true);
        else setError(message);
      })
      .finally(() => setLoading(false));
  }, [schoolId, studentId]);

  useEffect(() => { load(); }, [load]);

  async function handleSave() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await apiFetch(`/api/schools/${schoolId}/principal-remarks/${studentId}`, {
        method: 'PUT',
        body: JSON.stringify({ remark_text: text }),
      });
      setSaved(true);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the remark');
    } finally {
      setSaving(false);
    }
  }

  const dirty = (data?.remark_text ?? '') !== text;

  return (
    <div className="card p-6 mb-6">
      <h2 className="font-heading text-sm font-semibold text-gray-900 mb-1">Principal&apos;s Remark</h2>
      <p className="text-sm text-gray-500 mb-4">
        {noTerm
          ? 'No term is currently active, so there is no report card to write on yet.'
          : <>Appears on {studentName}&apos;s report card for{' '}
              <span className="font-medium text-gray-700">{data?.term_name ?? 'this term'}</span>.
              Saving replaces the previous remark for the same term.</>}
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {saved && !dirty && (
        <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Saved. It will appear on the next report card generated for this term.
        </div>
      )}

      {loading ? (
        <div className="skeleton h-24 w-full rounded-lg" />
      ) : noTerm ? null : (
        <>
          <textarea
            value={text}
            onChange={e => { setText(e.target.value.slice(0, MAX_LENGTH)); setSaved(false); }}
            rows={4}
            placeholder="A short remark for this student's report card…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#2472B4] focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-gray-400">{text.length} / {MAX_LENGTH}</span>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              className="btn-primary !px-4 !py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Save remark'}
            </button>
          </div>
          {(data?.remark_text ?? '') !== '' && text === '' && (
            /* Clearing is allowed and is a real edit, so say what it will do before they
               commit rather than after. */
            <p className="mt-2 text-xs text-amber-700">
              Saving now removes the remark from this term&apos;s report card.
            </p>
          )}
        </>
      )}
    </div>
  );
}
