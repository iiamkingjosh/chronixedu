'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RowParent {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  relationship_type: string | null;
  is_primary_contact: boolean;
}

interface RowValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  student: {
    row_number: number;
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
    dob: string | null;
    gender: string | null;
    address: string | null;
    blood_group: string | null;
    emergency_contact_name: string | null;
    emergency_contact_phone: string | null;
    parent1: RowParent | null;
    parent2: RowParent | null;
  };
}

interface CommitResult {
  created: number;
  failed: number;
  results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string; admission_no?: string }>;
  download_base64: string;
}

type Step = 'upload' | 'preview' | 'done';

function parentSummary(student: RowValidationResult['student']): string {
  const names = [student.parent1, student.parent2]
    .filter((p): p is RowParent => !!p)
    .map(p => `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim())
    .filter(Boolean);
  return names.length > 0 ? names.join(', ') : '—';
}

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

export default function StudentBulkImportPage() {
  const { schoolId } = useAuth();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [rows, setRows] = useState<RowValidationResult[]>([]);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [commitError, setCommitError] = useState('');

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !file) return;
    setUploading(true);
    setUploadError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiUpload<{ success: boolean; data: { rows: RowValidationResult[] } }>(
        `/api/schools/${schoolId}/students/bulk-import/preview`,
        formData
      );
      setRows(res.data.rows);
      setStep('preview');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to process this file');
    } finally {
      setUploading(false);
    }
  }

  async function handleCommit() {
    if (!schoolId) return;
    setCommitting(true);
    setCommitError('');
    try {
      const validRows = rows.filter(r => r.status === 'valid');
      const res = await apiFetch<{ success: boolean; data: CommitResult }>(
        `/api/schools/${schoolId}/students/bulk-import/commit`,
        { method: 'POST', body: JSON.stringify({ rows: validRows }) }
      );
      setCommitResult(res.data);
      setStep('done');
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setCommitting(false);
    }
  }

  const validCount = rows.filter(r => r.status === 'valid').length;
  const invalidCount = rows.length - validCount;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-6">
        <Link href="/registrar/students" className="text-sm text-[#2472B4] hover:underline">← Back to Students</Link>
        <h1 className="text-xl font-semibold text-gray-900 mt-2">Bulk Import Students</h1>
        <p className="text-sm text-gray-500 mt-1">Upload a spreadsheet to register up to 200 students (and their parents) at once.</p>
      </div>

      {step === 'upload' && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <a
            href="/templates/student-bulk-import-template.xlsx"
            download
            className="inline-block text-sm font-medium text-[#2472B4] hover:underline"
          >
            Download the import template (.xlsx)
          </a>
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

      {step === 'preview' && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <p className="text-sm text-gray-700">
              <span className="font-semibold text-green-700">{validCount} of {rows.length} rows valid</span>
              {invalidCount > 0 && <span className="text-red-600"> — {invalidCount} row(s) have errors and will be skipped</span>}
            </p>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs uppercase text-gray-400">
                  <th className="px-4 py-2">Row</th>
                  <th className="px-4 py-2">Student</th>
                  <th className="px-4 py-2">Parent(s)</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(r => (
                  <tr key={r.row_number}>
                    <td className="px-4 py-2 text-gray-500">{r.row_number}</td>
                    <td className="px-4 py-2">{r.student.first_name} {r.student.last_name}</td>
                    <td className="px-4 py-2 text-gray-500">{parentSummary(r.student)}</td>
                    <td className="px-4 py-2">
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
              disabled={validCount === 0 || committing}
              className="px-5 py-2 bg-[#FF761B] text-white text-sm font-medium rounded-lg hover:bg-[#e56812] disabled:opacity-50"
            >
              {committing ? 'Importing…' : `Import ${validCount} valid student${validCount === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              onClick={() => { setStep('upload'); setFile(null); setRows([]); }}
              className="px-5 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {step === 'done' && commitResult && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <p className="text-lg font-semibold text-gray-900">
            {commitResult.created} student{commitResult.created === 1 ? '' : 's'} created
            {commitResult.failed > 0 && <span className="text-red-600">, {commitResult.failed} failed</span>}
          </p>

          {commitResult.failed > 0 && (
            <div className="space-y-1">
              {commitResult.results.filter(r => r.status === 'failed').map(r => (
                <p key={r.row_number} className="text-sm text-red-700">Row {r.row_number}: {r.reason}</p>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => downloadBase64File(commitResult.download_base64, 'chronix-edu-bulk-import-results.xlsx')}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700"
          >
            Download results (.xlsx)
          </button>

          <div>
            <Link href="/registrar/students" className="text-sm text-[#2472B4] hover:underline">← Back to Students</Link>
          </div>
        </div>
      )}
    </div>
  );
}
