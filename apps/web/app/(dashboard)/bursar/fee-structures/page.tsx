'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import {
  Modal,
  ToastBanner,
  useToast,
  useTermsAndClasses,
  formatCurrency,
  type ClassOption,
} from '../shared';

interface FeeStructureRow {
  id: string;
  school_id: string;
  class_id: string | null;
  term_id: string;
  component_name: string;
  amount: number;
  is_mandatory: boolean;
  created_at: string;
}

interface FeeInvoiceRow {
  id: string;
  student_id: string;
  total_amount: number;
}

function classLabel(cls: ClassOption): string {
  return cls.stream ? `${cls.name} (${cls.stream})` : cls.name;
}

export default function FeeStructuresPage() {
  const { schoolId } = useAuth();
  const { terms, classes, currentTermId, loading: contextLoading, error: contextError } = useTermsAndClasses();
  const { toast, show } = useToast();

  const [termId, setTermId] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [structures, setStructures] = useState<FeeStructureRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const [showAddModal, setShowAddModal] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);

  useEffect(() => {
    if (!termId && currentTermId) setTermId(currentTermId);
  }, [currentTermId, termId]);

  useEffect(() => {
    if (!schoolId || !termId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    const params = new URLSearchParams({ term_id: termId });
    if (classFilter) params.set('class_id', classFilter);

    apiFetch<{ success: boolean; data: FeeStructureRow[] }>(`/api/schools/${schoolId}/fee-structures?${params}`)
      .then((res) => { if (!cancelled) setStructures(res.data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load fee structures'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [schoolId, termId, classFilter, refreshKey]);

  const selectedTerm = terms.find((t) => t.id === termId);

  return (
    <div className="max-w-5xl mx-auto p-8">
      <ToastBanner toast={toast} />

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Fee Structures</h1>
          <p className="text-sm text-gray-500 mt-1">Configure fee components and generate invoices for a term.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowGenerateModal(true)}
            disabled={!termId}
            className="btn-secondary"
          >
            Generate Invoices
          </button>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            disabled={!termId}
            className="btn-primary"
          >
            + Add Fee Component
          </button>
        </div>
      </div>

      {contextError && <p className="text-sm text-red-600 mb-4">{contextError}</p>}

      <div className="flex flex-wrap gap-4 mb-6">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Term</label>
          <select
            value={termId}
            onChange={(e) => setTermId(e.target.value)}
            disabled={contextLoading}
            className="input-field"
          >
            {terms.length === 0 && <option value="">No terms available</option>}
            {terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.sessionName} — {t.name}{t.isCurrent ? ' (Current)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Class</label>
          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            disabled={contextLoading}
            className="input-field"
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{classLabel(c)}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Component</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Applies To</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
              <th className="px-4 py-3 text-center font-medium text-gray-500">Mandatory</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
            )}
            {!loading && structures.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">No fee components configured for this term.</td></tr>
            )}
            {!loading && structures.map((s) => {
              const cls = classes.find((c) => c.id === s.class_id);
              return (
                <tr key={s.id} className="table-row-hover">
                  <td className="px-4 py-3 font-medium text-gray-900">{s.component_name}</td>
                  <td className="px-4 py-3 text-gray-600">{cls ? classLabel(cls) : 'All classes'}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(s.amount)}</td>
                  <td className="px-4 py-3 text-center">
                    {s.is_mandatory ? (
                      <span className="badge-info">Mandatory</span>
                    ) : (
                      <span className="badge-default">Optional</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showAddModal && termId && (
        <AddFeeStructureModal
          schoolId={schoolId!}
          termId={termId}
          termLabel={selectedTerm ? `${selectedTerm.sessionName} — ${selectedTerm.name}` : ''}
          classes={classes}
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false);
            setRefreshKey((k) => k + 1);
            show('Fee component added.');
          }}
          onError={(msg) => show(msg, 'error')}
        />
      )}

      {showGenerateModal && termId && (
        <GenerateInvoicesModal
          schoolId={schoolId!}
          termId={termId}
          termLabel={selectedTerm ? `${selectedTerm.sessionName} — ${selectedTerm.name}` : ''}
          classes={classes}
          onClose={() => setShowGenerateModal(false)}
          onSuccess={(count) => {
            setShowGenerateModal(false);
            show(`Generated ${count} invoice${count === 1 ? '' : 's'}.`);
          }}
          onError={(msg) => show(msg, 'error')}
        />
      )}
    </div>
  );
}

function AddFeeStructureModal({
  schoolId,
  termId,
  termLabel,
  classes,
  onClose,
  onSuccess,
  onError,
}: {
  schoolId: string;
  termId: string;
  termLabel: string;
  classes: ClassOption[];
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const [componentName, setComponentName] = useState('');
  const [amount, setAmount] = useState('');
  const [classId, setClassId] = useState('');
  const [isMandatory, setIsMandatory] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!componentName.trim() || !amount) return;

    setSubmitting(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/fee-structures`, {
        method: 'POST',
        body: JSON.stringify({
          term_id: termId,
          class_id: classId || null,
          component_name: componentName.trim(),
          amount: Number(amount),
          is_mandatory: isMandatory,
        }),
      });
      onSuccess();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to add fee component');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Add Fee Component" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-xs text-gray-500">Term: <span className="font-medium text-gray-700">{termLabel}</span></p>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Component Name</label>
          <input
            type="text"
            value={componentName}
            onChange={(e) => setComponentName(e.target.value)}
            placeholder="e.g. Tuition, PTA Levy, Sports Fee"
            required
            className="input-field"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Amount (₦)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className="input-field"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Applies To</label>
          <select
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="input-field"
          >
            <option value="">All classes (school-wide)</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{classLabel(c)}</option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isMandatory} onChange={(e) => setIsMandatory(e.target.checked)} className="rounded border-gray-300" />
          Mandatory (included in invoice totals)
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Saving…' : 'Add Component'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GenerateInvoicesModal({
  schoolId,
  termId,
  termLabel,
  classes,
  onClose,
  onSuccess,
  onError,
}: {
  schoolId: string;
  termId: string;
  termLabel: string;
  classes: ClassOption[];
  onClose: () => void;
  onSuccess: (count: number) => void;
  onError: (msg: string) => void;
}) {
  const [classId, setClassId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!classId) return;

    setSubmitting(true);
    try {
      const res = await apiFetch<{ success: boolean; data: FeeInvoiceRow[] }>(`/api/schools/${schoolId}/fee-invoices/generate`, {
        method: 'POST',
        body: JSON.stringify({ term_id: termId, class_id: classId }),
      });
      onSuccess(res.data.length);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to generate invoices');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Generate Invoices" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-xs text-gray-500">Term: <span className="font-medium text-gray-700">{termLabel}</span></p>
        <p className="text-sm text-gray-600">
          This will create or update fee invoices for every student in the selected class, based on the mandatory fee components configured for this term.
        </p>

        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Class</label>
          <select
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            required
            className="input-field"
          >
            <option value="">Select a class…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{classLabel(c)}</option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={submitting || !classId} className="btn-primary">
            {submitting ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
