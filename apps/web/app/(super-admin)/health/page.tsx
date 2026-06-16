'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getHealthOverview,
  getCronStatus,
  type HealthOverview,
  type CronStatusEntry,
} from '@/lib/superAdminApi';

const REFRESH_MS = 60_000;

function formatRelative(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function CronStatusBadge({ cron }: { cron: CronStatusEntry }) {
  if (cron.last_status === 'never') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
        Never Run
      </span>
    );
  }
  if (cron.is_stale) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-yellow-50 text-yellow-700 border border-yellow-200">
        Stale
      </span>
    );
  }
  if (cron.last_status === 'error') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-red-50 text-red-700 border border-red-200">
        Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-green-50 text-green-700 border border-green-200">
      OK
    </span>
  );
}

function StaleBadge({ isStale }: { isStale: boolean }) {
  return isStale ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-yellow-50 text-yellow-700 border border-yellow-200">Yes</span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">No</span>
  );
}

function StatusCard({ label, value, tone }: { label: string; value: string; tone: 'green' | 'yellow' | 'red' }) {
  const toneClasses: Record<typeof tone, string> = {
    green: 'text-green-600',
    yellow: 'text-yellow-600',
    red: 'text-red-600',
  };
  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <p className={`text-2xl font-bold ${toneClasses[tone]}`}>{value}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
    </div>
  );
}

export default function SuperAdminHealthPage() {
  const [overview, setOverview] = useState<HealthOverview | null>(null);
  const [crons, setCrons] = useState<CronStatusEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([getHealthOverview(), getCronStatus()])
      .then(([overviewData, cronsData]) => {
        setOverview(overviewData);
        setCrons(cronsData);
        setLastUpdated(new Date());
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">Platform Health</h1>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <p className="text-xs text-gray-400">Last updated {formatTime(lastUpdated.toISOString())}</p>
          )}
          <button
            type="button"
            onClick={load}
            className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            Refresh Now
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-white rounded-lg shadow-sm p-5 h-20 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && overview && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <StatusCard
            label="Active Support Sessions"
            value={String(overview.active_support_sessions)}
            tone={overview.active_support_sessions > 0 ? 'yellow' : 'green'}
          />
          <StatusCard
            label="Audit Events (24h)"
            value={String(overview.audit_events_24h)}
            tone="green"
          />
          <StatusCard
            label="Error Count (24h)"
            value={overview.error_count_24h === null ? 'N/A' : String(overview.error_count_24h)}
            tone={overview.error_count_24h ? 'red' : 'green'}
          />
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[680px]">
          <thead>
            <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
              <th className="py-3 px-4">Job</th>
              <th className="py-3 px-4">Schedule</th>
              <th className="py-3 px-4">Last Run</th>
              <th className="py-3 px-4">Status</th>
              <th className="py-3 px-4">Stale?</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr>
                <td colSpan={5} className="py-10 text-center text-gray-400">Loading…</td>
              </tr>
            )}
            {!loading && crons.length === 0 && (
              <tr>
                <td colSpan={5} className="py-10 text-center text-gray-400">No cron jobs found.</td>
              </tr>
            )}
            {!loading && crons.map((cron) => (
              <tr key={cron.name}>
                <td className="py-3 px-4 font-semibold text-gray-900">{cron.name}</td>
                <td className="py-3 px-4 text-gray-700">{cron.schedule}</td>
                <td className="py-3 px-4 text-gray-700">{formatRelative(cron.last_run)}</td>
                <td className="py-3 px-4"><CronStatusBadge cron={cron} /></td>
                <td className="py-3 px-4"><StaleBadge isStale={cron.is_stale} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
