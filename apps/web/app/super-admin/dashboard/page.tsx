'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/providers';
import {
  getSuperAdminOverview,
  getCronStatus,
  type SuperAdminOverview,
  type CronStatusEntry,
} from '@/lib/superAdminApi';

function getGreeting(firstName: string, lastName: string): string {
  const hour = new Date().getHours();
  const time = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return `${time}, ${firstName} ${lastName}`;
}

function formatNaira(value: number): string {
  return `₦${Math.round(value).toLocaleString('en-NG')}`;
}

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
  if (cron.last_status === 'success') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-green-50 text-green-700 border border-green-200">
        OK
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-red-50 text-red-700 border border-red-200">
      Error
    </span>
  );
}

function KpiCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <p className="text-2xl font-bold text-[#003366]">{value}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
    </div>
  );
}

function KpiCardSkeleton() {
  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <div className="h-7 w-20 bg-gray-200 rounded animate-pulse" />
      <div className="h-4 w-24 bg-gray-200 rounded animate-pulse mt-2" />
    </div>
  );
}

export default function SuperAdminDashboardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [overview, setOverview] = useState<SuperAdminOverview | null>(null);
  const [crons, setCrons] = useState<CronStatusEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getSuperAdminOverview(), getCronStatus()])
      .then(([overviewData, cronData]) => {
        setOverview(overviewData);
        setCrons(cronData);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-8 max-w-6xl">
        <div className="mb-8">
          <div className="h-7 w-56 bg-gray-200 rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <KpiCardSkeleton key={i} />
          ))}
        </div>
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

  if (!overview) return null;

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">
          {user ? getGreeting(user.first_name ?? 'Admin', user.last_name ?? '') : 'Platform Dashboard'}
        </h1>
        <p className="mt-1 text-sm text-gray-500">Platform Admin · Chronix Edu</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard label="Total Schools" value={overview.total_schools} />
        <KpiCard label="Active Schools" value={overview.active_schools} />
        <KpiCard label="Total Students" value={overview.total_students} />
        <KpiCard label="Monthly MRR" value={formatNaira(overview.total_mrr_naira)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-lg shadow-sm p-5">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Cron Status</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
                  <th className="py-2 pr-4">Job Name</th>
                  <th className="py-2 pr-4">Schedule</th>
                  <th className="py-2 pr-4">Last Run</th>
                  <th className="py-2 pr-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {crons.map((cron) => (
                  <tr key={cron.name}>
                    <td className="py-2 pr-4 font-medium text-gray-900">{cron.name}</td>
                    <td className="py-2 pr-4 text-gray-500 font-mono text-xs">{cron.schedule}</td>
                    <td className="py-2 pr-4 text-gray-500">{formatRelative(cron.last_run)}</td>
                    <td className="py-2 pr-4">
                      <CronStatusBadge cron={cron} />
                    </td>
                  </tr>
                ))}
                {crons.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-gray-400">
                      No cron jobs registered.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-5">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Quick Actions</h2>
          <button
            type="button"
            onClick={() => router.push('/super-admin/onboard')}
            className="w-full mb-2 bg-[#003366] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[#002244]"
          >
            Onboard New School
          </button>
          <button
            type="button"
            onClick={() => router.push('/super-admin/schools')}
            className="w-full mb-2 bg-[#003366] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[#002244]"
          >
            View All Schools
          </button>
          <button
            type="button"
            onClick={() => router.push('/super-admin/announcements')}
            className="w-full mb-2 bg-[#003366] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[#002244]"
          >
            Post Announcement
          </button>
        </div>
      </div>
    </div>
  );
}
