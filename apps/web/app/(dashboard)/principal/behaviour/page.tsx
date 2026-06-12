'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

type Severity = 'minor' | 'serious' | 'suspension';

interface RecentIncident {
  id: string;
  incident_type: string;
  description: string | null;
  sanction: string | null;
  severity: Severity;
  date: string;
  class_name: string;
  student_name: string;
  admission_no: string;
  reported_by_name: string;
  parent_notified_at: string | null;
}

interface BehaviourSummary {
  term_id: string | null;
  term_name: string | null;
  total: number;
  by_severity: { minor: number; serious: number; suspension: number };
  recent: RecentIncident[];
}

const SEVERITY_BADGE: Record<Severity, string> = {
  minor: 'bg-amber-50 text-amber-700 border-amber-200',
  serious: 'bg-orange-50 text-orange-700 border-orange-200',
  suspension: 'bg-red-50 text-red-700 border-red-200',
};

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl bg-white border border-gray-200 p-5 shadow-sm">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-[#003366]">{value}</p>
      {sub && <p className="mt-1 text-sm text-gray-500">{sub}</p>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PrincipalBehaviourPage() {
  const { schoolId } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<BehaviourSummary | null>(null);

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: BehaviourSummary }>(`/api/schools/${schoolId}/behaviour/summary`)
      .then(({ data }) => { if (!cancelled) setSummary(data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load behaviour summary'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId]);

  if (!schoolId || loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-500">Loading behaviour summary…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900">Behaviour</h1>
        <p className="mt-1 text-sm text-gray-500">
          {summary.term_name ? `${summary.term_name} · School-wide incident summary` : 'No active term'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total incidents" value={summary.total} />
        <StatCard label="Minor" value={summary.by_severity.minor} />
        <StatCard label="Serious" value={summary.by_severity.serious} />
        <StatCard label="Suspensions" value={summary.by_severity.suspension} />
      </div>

      <div className="rounded-xl bg-white border border-gray-200 shadow-sm">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Recent incidents</h2>
        </div>
        {summary.recent.length === 0 ? (
          <p className="text-sm text-gray-500 px-6 py-8 text-center">No incidents recorded this term.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {summary.recent.map(r => (
              <div key={r.id} className="px-6 py-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {r.student_name} <span className="text-gray-400 font-normal">· {r.admission_no} · {r.class_name}</span>
                    </p>
                    <p className="text-sm text-gray-700 mt-0.5">{r.incident_type}</p>
                    <p className="text-xs text-gray-500 mt-1">
                      {new Date(r.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })} · Reported by {r.reported_by_name}
                    </p>
                  </div>
                  <span className={`shrink-0 text-[10px] font-medium uppercase tracking-wide px-2 py-1 rounded-md border ${SEVERITY_BADGE[r.severity]}`}>
                    {r.severity}
                  </span>
                </div>
                {r.description && <p className="text-sm text-gray-700 mt-2">{r.description}</p>}
                {r.sanction && <p className="text-xs text-gray-500 mt-1">Sanction: {r.sanction}</p>}
                <p className="text-[11px] text-gray-400 mt-1.5">
                  {r.parent_notified_at
                    ? `Parent notified ${new Date(r.parent_notified_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                    : 'Parent notification queued'}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
