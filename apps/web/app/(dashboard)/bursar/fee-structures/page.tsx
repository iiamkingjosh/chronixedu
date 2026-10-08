'use client';

import Link from 'next/link';
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
  // A fee line could be added and never corrected (audit, 8 Oct 2026).
  const [editing, setEditing] = useState<FeeStructureRow | null>(null);
  const [showCopyModal, setShowCopyModal] = useState(false);

  function afterChange(message: string, invoicesToRegenerate: number) {
    setRefreshKey((k) => k + 1);
    show(invoicesToRegenerate > 0
      ? `${message} ${invoicesToRegenerate} invoice${invoicesToRegenerate === 1 ? ' was' : 's were'} raised before this change: generate invoices again to update ${invoicesToRegenerate === 1 ? 'it' : 'them'}.`
      : message);
  }

  async function deleteLine(row: FeeStructureRow) {
    if (!schoolId) return;
    if (!window.confirm(`Delete the fee line "${row.component_name}"?`)) return;
    try {
      const res = await apiFetch<{ success: boolean; data: { invoices_to_regenerate: number } }>(
        `/api/schools/${schoolId}/fee-structures/${row.id}`, { method: 'DELETE' });
      afterChange('Fee line deleted.', res.data.invoices_to_regenerate);
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to delete the fee line', 'error');
    }
  }

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

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Fee Structures</h1>
          <p className="text-sm text-gray-500 mt-1">Configure fee components and generate invoices for a term.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/bursar/fee-structures/import" className="btn-secondary">
            Bulk Import Payments
          </Link>
          <button
            type="button"
            onClick={() => setShowCopyModal(true)}
            disabled={!termId || terms.length < 2}
            className="btn-secondary"
          >
            Copy From Another Term
          </button>
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
        <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Component</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500">Applies To</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
              <th className="px-4 py-3 text-center font-medium text-gray-500">Mandatory</th>
              <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
            )}
            {!loading && structures.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">No fee components configured for this term.</td></tr>
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
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button type="button" onClick={() => setEditing(s)} className="text-sm font-medium text-slate-700 hover:text-slate-900 mr-3">Edit</button>
                    <button type="button" onClick={() => deleteLine(s)} className="text-sm font-medium text-red-600 hover:text-red-800">Delete</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
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

      {editing && (
        <EditFeeStructureModal
          schoolId={schoolId!}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(n) => { setEditing(null); afterChange('Fee line saved.', n); }}
        />
      )}

      {showCopyModal && termId && (
        <CopyFeeLinesModal
          schoolId={schoolId!}
          toTermId={termId}
          terms={terms.filter((t) => t.id !== termId).map((t) => ({ id: t.id, label: `${t.sessionName} — ${t.name}` }))}
          toLabel={selectedTerm ? `${selectedTerm.sessionName} — ${selectedTerm.name}` : ''}
          onClose={() => setShowCopyModal(false)}
          onCopied={(copied, skipped) => {
            setShowCopyModal(false);
            setRefreshKey((k) => k + 1);
            show(`${copied} fee line${copied === 1 ? '' : 's'} copied${skipped > 0 ? `, ${skipped} already here` : ''}.`);
          }}
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
          // Text, so the exact naira typed reaches the server: no float on either side (doctrine 11).
          amount: amount.trim(),
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
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 15000 or 15000.50"
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

function EditFeeStructureModal({ schoolId, row, onClose, onSaved }: {
  schoolId: string;
  row: FeeStructureRow;
  onClose: () => void;
  onSaved: (invoicesToRegenerate: number) => void;
}) {
  const [componentName, setComponentName] = useState(row.component_name);
  const [amount, setAmount] = useState(String(row.amount));
  const [isMandatory, setIsMandatory] = useState(row.is_mandatory);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { invoices_to_regenerate: number } }>(
        `/api/schools/${schoolId}/fee-structures/${row.id}`,
        { method: 'PATCH', body: JSON.stringify({ component_name: componentName.trim(), amount: amount.trim(), is_mandatory: isMandatory }) }
      );
      onSaved(res.data.invoices_to_regenerate);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the fee line');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Edit Fee Line" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Component Name</label>
          <input type="text" value={componentName} onChange={(e) => setComponentName(e.target.value)} required className="input-field" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Amount (₦)</label>
          <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required className="input-field" />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isMandatory} onChange={(e) => setIsMandatory(e.target.checked)} className="rounded border-gray-300" />
          Mandatory (included in invoice totals)
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={submitting} className="btn-primary">{submitting ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function CopyFeeLinesModal({ schoolId, toTermId, toLabel, terms, onClose, onCopied }: {
  schoolId: string;
  toTermId: string;
  toLabel: string;
  terms: Array<{ id: string; label: string }>;
  onClose: () => void;
  onCopied: (copied: number, skipped: number) => void;
}) {
  const [fromTermId, setFromTermId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!fromTermId) { setError('Choose the term to copy from.'); return; }
    setError('');
    setSubmitting(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { copied: number; skipped: number } }>(
        `/api/schools/${schoolId}/fee-structures/copy-from-term`,
        { method: 'POST', body: JSON.stringify({ from_term_id: fromTermId, to_term_id: toTermId }) }
      );
      onCopied(res.data.copied, res.data.skipped);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Copy failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Copy Fee Lines" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-gray-600">
          Copy every fee line of another term into <span className="font-medium">{toLabel}</span>. Lines {toLabel} already has are kept as they are.
        </p>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Copy from</label>
          <select value={fromTermId} onChange={(e) => setFromTermId(e.target.value)} className="input-field">
            <option value="">Choose a term…</option>
            {terms.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={submitting} className="btn-primary">{submitting ? 'Copying…' : 'Copy Lines'}</button>
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
