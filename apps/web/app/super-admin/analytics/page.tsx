'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const GrowthLineChart = dynamic(
  () => import('@/components/charts/GrowthLineChart'),
  { ssr: false, loading: () => <div className="h-[250px] animate-pulse bg-gray-100 rounded-lg" /> }
);
import {
  getSuperAdminOverview,
  getGrowthData,
  getFeatureAdoption,
  getSchoolsActivity,
  type GrowthData,
  type FeatureAdoption,
  type SchoolActivity,
} from '@/lib/superAdminApi';

function StatusBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-green-50 text-green-700 border-green-200">Active</span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-red-50 text-red-700 border-red-200">Inactive</span>
  );
}

export default function SuperAdminAnalyticsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [growth, setGrowth] = useState<GrowthData | null>(null);
  const [featureAdoption, setFeatureAdoption] = useState<FeatureAdoption[]>([]);
  const [schools, setSchools] = useState<SchoolActivity[]>([]);

  useEffect(() => {
    Promise.all([getSuperAdminOverview(), getGrowthData(), getFeatureAdoption(), getSchoolsActivity()])
      .then(([, growthData, adoptionData, schoolsData]) => {
        setGrowth(growthData);
        setFeatureAdoption(adoptionData);
        setSchools(schoolsData);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-8 max-w-6xl">
        <div className="h-7 w-40 bg-gray-200 rounded animate-pulse mb-6" />
        <div className="h-64 bg-white rounded-lg shadow-sm animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-6xl">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  const growthChartData = (growth?.months ?? []).map((month, i) => ({
    month,
    schools: growth?.schools[i] ?? 0,
    students: growth?.students[i] ?? 0,
  }));

  const dormantSchools = schools.filter((s) => s.is_dormant);
  const topSchools = schools.slice(0, 20);

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">Analytics</h1>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-5 mb-4">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Growth</h2>
        <GrowthLineChart data={growthChartData} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="bg-white rounded-lg shadow-sm p-5">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Feature Adoption</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
                <th className="py-2 pr-4">Feature</th>
                <th className="py-2 pr-4">Schools Using</th>
                <th className="py-2 pr-4">Adoption %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {featureAdoption.map((f) => (
                <tr key={f.feature}>
                  <td className="py-2 pr-4 font-medium text-gray-900">{f.feature}</td>
                  <td className="py-2 pr-4 text-gray-700">{f.schools_using} / {f.total_active}</td>
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-2 bg-[#003366] rounded-full" style={{ width: `${f.adoption_pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-500 w-10 text-right">{f.adoption_pct}%</span>
                    </div>
                  </td>
                </tr>
              ))}
              {featureAdoption.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-4 text-center text-gray-400">No feature data available.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-5">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Dormant Schools</h2>
          {dormantSchools.length === 0 ? (
            <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
              No dormant schools
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {dormantSchools.map((s) => (
                <li key={s.school_id} className="py-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900">{s.school_name}</span>
                  <span className="text-xs text-gray-400">last activity (activity_score: {s.activity_score})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-4">School Activity</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[680px]">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
                <th className="py-2 pr-4">School</th>
                <th className="py-2 pr-4">Activity Score</th>
                <th className="py-2 pr-4">Logins</th>
                <th className="py-2 pr-4">Scores</th>
                <th className="py-2 pr-4">Attendance</th>
                <th className="py-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {topSchools.map((s) => (
                <tr key={s.school_id}>
                  <td className="py-2 pr-4 font-medium text-gray-900">{s.school_name}</td>
                  <td className="py-2 pr-4 text-gray-700">{s.activity_score}</td>
                  <td className="py-2 pr-4 text-gray-700">{s.logins_30d}</td>
                  <td className="py-2 pr-4 text-gray-700">{s.score_entries_30d}</td>
                  <td className="py-2 pr-4 text-gray-700">{s.attendance_marks_30d}</td>
                  <td className="py-2 pr-4"><StatusBadge isActive={s.is_active} /></td>
                </tr>
              ))}
              {topSchools.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-gray-400">No school activity data available.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
