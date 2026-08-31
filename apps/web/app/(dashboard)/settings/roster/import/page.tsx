'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassRow {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  class: { name: string; level: string; stream: string | null; form_teacher_email: string | null };
  resolved_form_teacher_id: string | null;
}

interface SubjectRow {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  subject: { name: string; code: string };
}

interface AssignmentRow {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  assignment: { teacher_email: string; class_name: string; subject_code: string };
  resolved_teacher_id: string | null;
  resolved_class_id: string | null;
  resolved_subject_id: string | null;
}

interface PreviewResponse {
  classes: { rows: ClassRow[]; summary: { total: number; valid: number; invalid: number } };
  subjects: { rows: SubjectRow[]; summary: { total: number; valid: number; invalid: number } };
  assignments: { rows: AssignmentRow[]; summary: { total: number; valid: number; invalid: number } };
}

interface CommitSheetResult {
  created: number;
  failed: number;
  results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }>;
}

interface CommitResponse {
  classes: CommitSheetResult;
  subjects: CommitSheetResult;
  assignments: CommitSheetResult;
  download_base64: string | null;
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

function SheetPreviewTable<T extends { row_number: number; status: 'valid' | 'error'; errors: string[] }>({
  title,
  rows,
  renderLabel,
}: {
  title: string;
  rows: T[];
  renderLabel: (row: T) => string;
}) {
  const validCount = rows.filter(r => r.status === 'valid').length;
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <span className="text-xs text-gray-500">{validCount} of {rows.length} valid</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 px-4 py-6 text-center">No rows in this sheet.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.row_number}>
                <td className="px-4 py-2 text-gray-500 w-16">{r.row_number}</td>
                <td className="px-4 py-2">{renderLabel(r)}</td>
                <td className="px-4 py-2 w-40">
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
      )}
    </div>
  );
}

function CommitFailures({ title, result }: { title: string; result: CommitSheetResult }) {
  const failures = result.results.filter(r => r.status === 'failed');
  if (failures.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-red-700">{title} — {failures.length} failed</p>
      {failures.map(r => (
        <p key={r.row_number} className="text-sm text-red-700 pl-3">Row {r.row_number}: {r.reason}</p>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RosterBulkImportPage() {
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
        `/api/schools/${schoolId}/roster-bulk-import/preview`,
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
        `/api/schools/${schoolId}/roster-bulk-import/commit`,
        {
          method: 'POST',
          body: JSON.stringify({
            classes: preview.classes.rows.filter(r => r.status === 'valid'),
            subjects: preview.subjects.rows.filter(r => r.status === 'valid'),
            assignments: preview.assignments.rows.filter(r => r.status === 'valid'),
          }),
        }
      );
      setCommitResult(res.data);
      setStep('done');
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setCommitting(false);
    }
  }

  const totalValid = preview
    ? preview.classes.summary.valid + preview.subjects.summary.valid + preview.assignments.summary.valid
    : 0;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-6">
        <Link href="/settings/roster" className="text-sm text-[#2472B4] hover:underline">← Back to Roster</Link>
        <h1 className="text-xl font-semibold text-gray-900 mt-2">Bulk Import Roster</h1>
        <p className="text-sm text-gray-500 mt-1">Upload a workbook with Classes, Subjects, and Teacher Assignments sheets — up to 300 rows total.</p>
      </div>

      {step === 'upload' && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <a
            href="/templates/roster-bulk-import-template.xlsx"
            download
            className="inline-block text-sm font-medium text-[#2472B4] hover:underline"
          >
            Download the import template (.xlsx)
          </a>
          <p className="text-xs text-gray-500">
            Teacher Assignment rows must reference classes/subjects/teachers that already exist — if you&apos;re setting up a new school, import Classes and Subjects first, then do a second import for Teacher Assignments.
          </p>
          <form onSubmit={handleUpload} className="space-y-4">
            <input
              type="file"
              accept=".xlsx"
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
          <SheetPreviewTable
            title="Classes"
            rows={preview.classes.rows}
            renderLabel={(r: ClassRow) => `${r.class.name} (${r.class.level})`}
          />
          <SheetPreviewTable
            title="Subjects"
            rows={preview.subjects.rows}
            renderLabel={(r: SubjectRow) => `${r.subject.name} (${r.subject.code})`}
          />
          <SheetPreviewTable
            title="Teacher Assignments"
            rows={preview.assignments.rows}
            renderLabel={(r: AssignmentRow) => `${r.assignment.teacher_email} → ${r.assignment.class_name} / ${r.assignment.subject_code}`}
          />

          {commitError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{commitError}</div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleCommit}
              disabled={totalValid === 0 || committing}
              className="px-5 py-2 bg-[#FF761B] text-white text-sm font-medium rounded-lg hover:bg-[#e56812] disabled:opacity-50"
            >
              {committing ? 'Importing…' : `Import ${totalValid} valid row${totalValid === 1 ? '' : 's'}`}
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
          <p className="text-lg font-semibold text-gray-900">
            {commitResult.classes.created} class(es), {commitResult.subjects.created} subject(s), {commitResult.assignments.created} assignment(s) created
          </p>

          <CommitFailures title="Classes" result={commitResult.classes} />
          <CommitFailures title="Subjects" result={commitResult.subjects} />
          <CommitFailures title="Teacher Assignments" result={commitResult.assignments} />

          {commitResult.download_base64 ? (
            <button
              type="button"
              onClick={() => downloadBase64File(commitResult.download_base64 as string, 'chronix-edu-roster-bulk-import-results.xlsx')}
              className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700"
            >
              Download results (.xlsx)
            </button>
          ) : (
            <p className="text-sm text-gray-500">Results file unavailable — see the lists above for what was recorded.</p>
          )}

          <div>
            <Link href="/settings/roster" className="text-sm text-[#2472B4] hover:underline">← Back to Roster</Link>
          </div>
        </div>
      )}
    </div>
  );
}
