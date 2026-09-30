'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch, apiFetchBlob } from '@/lib/api';

/**
 * The school's complete data export: every record, one spreadsheet (CSV) per kind. This is
 * what the Data Processing Agreement promises on termination, and it stays available while
 * a school is read-only — its data is its own whether or not it renews.
 */
interface Dataset { key: string; label: string; rows: number }

export default function DataExportPage() {
  const { schoolId } = useAuth();
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: { datasets: Dataset[] } }>(`/api/schools/${schoolId}/export`)
      .then((res) => setDatasets(res.data.datasets))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the export list'));
  }, [schoolId]);

  async function download(d: Dataset) {
    if (!schoolId) return;
    setBusy(d.key);
    setError('');
    try {
      const blob = await apiFetchBlob(`/api/schools/${schoolId}/export/${d.key}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${d.key}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Could not download ${d.label}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-xl font-semibold text-gray-900 mb-1">Data Export</h1>
      <p className="text-sm text-gray-500 mb-8">
        Every record the school holds, one spreadsheet (CSV) each. Downloads are recorded in the audit log.
      </p>
      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>}
      {!datasets && !error && <p className="text-sm text-gray-500">Loading…</p>}
      {datasets && (
        <ul className="card divide-y divide-gray-100">
          {datasets.map((d) => (
            <li key={d.key} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{d.label}</p>
                <p className="text-xs text-gray-500">{d.rows.toLocaleString('en-NG')} row{d.rows === 1 ? '' : 's'}</p>
              </div>
              <button
                type="button"
                onClick={() => download(d)}
                disabled={busy !== null}
                className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-[#003366] hover:text-[#003366] disabled:opacity-50"
              >
                {busy === d.key ? 'Preparing…' : 'Download CSV'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
