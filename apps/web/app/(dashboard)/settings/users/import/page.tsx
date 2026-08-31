'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParsedStaff {
  row_number: number;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  title: string | null;
  phone: string | null;
  teacher_mode: string | null;
}

interface StaffRow {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  staff: ParsedStaff;
}

interface PreviewResponse {
  rows: StaffRow[];
  summary: { total: number; valid: number; invalid: number };
}

interface CommitResponse {
  created: number;
  failed: number;
  results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }>;
  download_base64: string;
}

type Step = 'upload' | 'preview' | 'done';

function downloadBase64File(base64: string, filename: string) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const blob = new Blob([new Uint8Array(byteNumbers)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StaffBulkImportPage() {
  const { schoolId } = useAuth();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);
  const [commitError, setCommitError] = useState('');

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !file) return;
    setUploading(true);
    setUploadError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiUpload<{ success: boolean; data: PreviewResponse }>(
        `/api/schools/${schoolId}/staff-bulk-import/preview`,
        formData
      );
      setPreview(res.data);
      setStep('preview');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to process this file');
    } finally {
      setUploading(false);
    }
  }

  async function handleCommit() {
    if (!schoolId || !preview) return;
    setCommitting(true);
    setCommitError('');
    try {
      const res = await apiFetch<{ success: boolean; data: CommitResponse }>(
        `/api/schools/${schoolId}/staff-bulk-import/commit`,
        { method: 'POST', body: JSON.stringify({ rows: preview.rows.filter(r => r.status === 'valid') }) }
      );
      setCommitResult(res.data);
      setStep('done');
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-6">
        <Link href="/settings/users" className="text-sm text-[#2472B4] hover:underline">← Back to User Management</Link>
        <h1 className="text-xl font-semibold text-gray-900 mt-2">Bulk Import Staff</h1>
        <p className="text-sm text-gray-500 mt-1">Upload a spreadsheet of teachers, registrars, bursars, or principals — up to 50 rows per import.</p>
      </div>

      {step === 'upload' && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <a
            href="/templates/staff-bulk-import-template.xlsx"
            download
            className="inline-block text-sm font-medium text-[#2472B4] hover:underline"
          >
            Download the import template (.xlsx)
          </a>
          <p className="text-xs text-gray-500">
            Every account created here gets the temporary password <span className="font-mono">Password2$</span> and a welcome email with their login details — they must change it on first login.
          </p>
          <form onSubmit={handleUpload} className="space-y-4">
            <input
              type="file"
              accept=".xlsx,.csv"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-700"
            />
            {uploadError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{uploadError}</div>
            )}
            <button
              type="submit"
              disabled={!file || uploading}
              className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
            >
              {uploading ? 'Processing…' : 'Upload & Preview'}
            </button>
          </form>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Staff</h3>
              <span className="text-xs text-gray-500">{preview.summary.valid} of {preview.summary.total} valid</span>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                {preview.rows.map(r => (
                  <tr key={r.row_number}>
                    <td className="px-4 py-2 text-gray-500 w-16">{r.row_number}</td>
                    <td className="px-4 py-2">{r.staff.first_name} {r.staff.last_name} — {r.staff.email} ({r.staff.role})</td>
                    <td className="px-4 py-2 w-56">
                      {r.status === 'valid' ? (
                        <span className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-md px-2 py-1">Will create</span>
                      ) : (
                        <span className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1" title={r.errors.join(' ')}>
                          Error: {r.errors[0]}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {commitError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{commitError}</div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleCommit}
              disabled={preview.summary.valid === 0 || committing}
              className="px-5 py-2 bg-[#FF761B] text-white text-sm font-medium rounded-lg hover:bg-[#e56812] disabled:opacity-50"
            >
              {committing ? 'Importing…' : `Import ${preview.summary.valid} valid row${preview.summary.valid === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              onClick={() => { setStep('upload'); setFile(null); setPreview(null); }}
              className="px-5 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {step === 'done' && commitResult && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <p className="text-lg font-semibold text-gray-900">{commitResult.created} staff account(s) created</p>
          {commitResult.failed > 0 && (
            <p className="text-sm text-red-600">{commitResult.failed} row(s) failed:</p>
          )}
          {commitResult.failed > 0 && (
            <div className="space-y-1">
              {commitResult.results.filter(r => r.status === 'failed').map(r => (
                <p key={r.row_number} className="text-sm text-red-700">Row {r.row_number}: {r.reason}</p>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => downloadBase64File(commitResult.download_base64, 'chronix-edu-staff-bulk-import-results.xlsx')}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700"
          >
            Download results (.xlsx)
          </button>
          <div>
            <Link href="/settings/users" className="text-sm text-[#2472B4] hover:underline">← Back to User Management</Link>
          </div>
        </div>
      )}
    </div>
  );
}
