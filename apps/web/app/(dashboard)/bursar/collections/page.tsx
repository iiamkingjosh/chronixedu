'use client';

import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import {
  ToastBanner,
  useToast,
  useTermsAndClasses,
  formatCurrency,
  STATUS_LABELS,
  type ClassOption,
} from '../shared';

interface CollectionSummary {
  total_expected: number;
  total_collected: number;
  total_outstanding: number;
  counts: {
    unpaid: number;
    partial: number;
    paid: number;
  };
}

const STATUS_COLORS: Record<'unpaid' | 'partial' | 'paid', string> = {
  unpaid: '#ef4444',
  partial: '#f59e0b',
  paid: '#22c55e',
};

function classLabel(cls: ClassOption): string {
  return cls.stream ? `${cls.name} (${cls.stream})` : cls.name;
}

export default function CollectionSummaryPage() {
  const { schoolId } = useAuth();
  const { terms, classes, currentTermId, loading: contextLoading, error: contextError } = useTermsAndClasses();
  const { toast } = useToast();

  const [termId, setTermId] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [summary, setSummary] = useState<CollectionSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

    apiFetch<{ success: boolean; data: CollectionSummary }>(`/api/schools/${schoolId}/fee-invoices/summary?${params}`)
      .then((res) => { if (!cancelled) setSummary(res.data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load collection summary'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [schoolId, termId, classFilter]);

  const barData = summary
    ? [
        { name: 'Expected', amount: summary.total_expected },
        { name: 'Collected', amount: summary.total_collected },
        { name: 'Outstanding', amount: summary.total_outstanding },
      ]
    : [];

  const pieData = summary
    ? (['unpaid', 'partial', 'paid'] as const)
        .map((status) => ({ name: STATUS_LABELS[status], value: summary.counts[status], status }))
        .filter((d) => d.value > 0)
    : [];

  const collectionRate = summary && summary.total_expected > 0
    ? (summary.total_collected / summary.total_expected) * 100
    : 0;

  return (
    <div className="max-w-5xl mx-auto p-8">
      <ToastBanner toast={toast} />

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Collection Summary</h1>
        <p className="text-sm text-gray-500 mt-1">Overview of fee collection for a term.</p>
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

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card p-4">
              <div className="skeleton h-3 w-20" />
              <div className="skeleton h-6 w-24 mt-2" />
            </div>
          ))}
        </div>
      )}

      {!loading && summary && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8">
            <div className="card card-hover p-4">
              <p className="text-xs font-medium text-gray-500">Total Expected</p>
              <p className="stat-value text-lg font-semibold font-heading text-[#003366] mt-1">{formatCurrency(summary.total_expected)}</p>
            </div>
            <div className="card card-hover p-4">
              <p className="text-xs font-medium text-gray-500">Total Collected</p>
              <p className="stat-value text-lg font-semibold font-heading text-green-700 mt-1">{formatCurrency(summary.total_collected)}</p>
            </div>
            <div className="card card-hover p-4">
              <p className="text-xs font-medium text-gray-500">Outstanding</p>
              <p className="stat-value text-lg font-semibold font-heading text-red-700 mt-1">{formatCurrency(summary.total_outstanding)}</p>
            </div>
            <div className="card card-hover p-4">
              <p className="text-xs font-medium text-gray-500">Collection Rate</p>
              <p className="stat-value text-lg font-semibold font-heading text-[#FF761B] mt-1">{collectionRate.toFixed(1)}%</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">Amounts (₦)</h2>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={barData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `₦${Number(v).toLocaleString('en-NG')}`} width={80} />
                  <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                  <Bar dataKey="amount" fill="#003366" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">Invoices by Status</h2>
              {pieData.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-16">No invoices for this term.</p>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                      {pieData.map((entry) => (
                        <Cell key={entry.status} fill={STATUS_COLORS[entry.status]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
