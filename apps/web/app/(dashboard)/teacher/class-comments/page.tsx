'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassCommentStudent {
  student_id: string;
  full_name: string;
  admission_no: string;
  comment_text: string | null;
}

interface ClassCommentsData {
  class: { id: string; name: string; level: string; stream: string | null };
  term: { id: string; name: string };
  students: ClassCommentStudent[];
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ClassCommentsPage() {
  const { schoolId, user } = useAuth();
  const { toast, show } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ClassCommentsData | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const [signatureUrl, setSignatureUrl] = useState<string | null>(null);
  const [signaturePreview, setSignaturePreview] = useState<string | null>(null);
  const [signatureUploading, setSignatureUploading] = useState(false);

  const load = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    setError(null);
    apiFetch<{ success: boolean; data: ClassCommentsData }>(`/api/schools/${schoolId}/class-comments`)
      .then(({ data }) => {
        setData(data);
        const initial: Record<string, string> = {};
        for (const s of data.students) initial[s.student_id] = s.comment_text ?? '';
        setDrafts(initial);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load class comments'))
      .finally(() => setLoading(false));
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  // Load current signature
  useEffect(() => {
    if (!schoolId || !user) return;
    apiFetch<{ success: boolean; data: { users: { id: string; signature_url: string | null }[] } }>(
      `/api/schools/${schoolId}/users?role=teacher&limit=100`
    )
      .then(({ data }) => setSignatureUrl(data.users.find(u => u.id === user.user_id)?.signature_url ?? null))
      .catch(() => {});
  }, [schoolId, user]);

  const onDropSignature = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file || !schoolId || !user) return;
    setSignaturePreview(URL.createObjectURL(file));
    setSignatureUploading(true);
    try {
      const fd = new FormData();
      fd.append('signature', file);
      const res = await apiUpload<{ success: boolean; data: { signature_url: string } }>(
        `/api/schools/${schoolId}/users/${user.user_id}/signature`,
        fd
      );
      setSignatureUrl(res.data.signature_url);
      show('Signature uploaded');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Signature upload failed', 'error');
      setSignaturePreview(null);
    } finally {
      setSignatureUploading(false);
    }
  }, [schoolId, user, show]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onDropSignature,
    accept: { 'image/jpeg': [], 'image/png': [] },
    maxFiles: 1,
    maxSize: 2 * 1024 * 1024,
  });

  async function handleSaveComment(studentId: string) {
    if (!schoolId) return;
    setSavingId(studentId);
    try {
      await apiFetch(`/api/schools/${schoolId}/class-comments/${studentId}`, {
        method: 'PUT',
        body: JSON.stringify({ comment_text: drafts[studentId] ?? '' }),
      });
      show('Comment saved');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to save comment', 'error');
    } finally {
      setSavingId(null);
    }
  }

  const displaySignature = signaturePreview ?? signatureUrl;

  if (!schoolId || loading) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <div className="skeleton h-6 w-48 mb-2" />
        <div className="skeleton h-4 w-80 mb-6" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">{error}</div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="max-w-4xl mx-auto p-8">
      {toast && (
        <div className={`toast-enter fixed top-4 right-4 z-50 px-4 py-3 rounded-md shadow-lift text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <h1 className="text-xl font-semibold text-gray-900 mb-1">Class Comments</h1>
      <p className="text-sm text-gray-500 mb-6">
        {data.class.name}{data.class.stream ? ` (${data.class.stream})` : ''} — {data.term.name}.
        Leave one overall remark per student, printed on their report card.
      </p>

      <div className="card overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Student</th>
              <th className="px-4 py-3 text-left font-medium">Admission No.</th>
              <th className="px-4 py-3 text-left font-medium">Remark</th>
              <th className="px-4 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.students.map(s => (
              <tr key={s.student_id}>
                <td className="px-4 py-3 whitespace-nowrap text-gray-900">{s.full_name}</td>
                <td className="px-4 py-3 whitespace-nowrap text-gray-500">{s.admission_no}</td>
                <td className="px-4 py-3">
                  <textarea
                    value={drafts[s.student_id] ?? ''}
                    onChange={e => setDrafts(prev => ({ ...prev, [s.student_id]: e.target.value }))}
                    maxLength={1000}
                    rows={2}
                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
                    placeholder="Write a remark for this student…"
                  />
                </td>
                <td className="px-4 py-3 text-right align-top">
                  <button
                    onClick={() => handleSaveComment(s.student_id)}
                    disabled={savingId === s.student_id}
                    className="btn-secondary"
                  >
                    {savingId === s.student_id ? 'Saving…' : 'Save'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="card p-6 space-y-4">
        <h2 className="font-heading text-sm font-semibold text-gray-700 uppercase tracking-wide">My Signature</h2>
        <p className="text-sm text-gray-500">Uploaded as an image and printed on each student&rsquo;s report card as your signature.</p>

        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors duration-200 ${
            isDragActive ? 'border-[#2472B4] bg-blue-50' : 'border-gray-300 hover:border-gray-400'
          }`}
        >
          <input {...getInputProps()} />
          {displaySignature ? (
            <div className="flex flex-col items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={displaySignature} alt="Signature preview" className="h-16 object-contain" />
              <p className="text-xs text-gray-500">
                {signatureUploading ? 'Uploading…' : 'Drop a new image to replace'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="mx-auto w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="text-sm text-gray-600">
                {isDragActive ? 'Drop image here' : 'Drag & drop a signature image, or click to browse'}
              </p>
              <p className="text-xs text-gray-400">PNG, JPG · max 2 MB</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
