'use client';

/**
 * Grading by level — the screen `academic_config.level_overrides` never had.
 *
 * The resolver (`fetchAcademicConfig`) and the report card have honoured per-level
 * overrides for weeks; nothing in the product could set one. A school running a primary
 * and a secondary section had one pass mark and one grading scale for both.
 *
 * Four rules this page is built around, each because breaking it fails silently:
 *
 * 1. **Levels come from the API's list, never a text box.** `classes.level` is matched
 *    exactly, so an override keyed "Jss" for classes whose level is "JSS" does nothing.
 *    The list is built from the levels real classes carry.
 * 2. **"Same as school-wide" is not "the same number"** (doctrine 8). An override that is
 *    absent follows future school-wide changes; one that is present is pinned, even if
 *    it currently equals the school-wide value. So each field is an explicit choice, and
 *    a number is never pre-filled into an override the user did not ask for.
 * 3. **Saving replaces the whole map.** Anything this page does not put in the map is
 *    deleted — including overrides for levels no class carries any more. Those are kept
 *    unless removed on purpose; losing them because the page didn't list them would be
 *    the page inferring a decision nobody made.
 * 4. **Read uncached.** The general school GET is cached; a stale read followed by a
 *    wholesale save would write old overrides back over new ones.
 *
 * Band validation is left to the server, whose error names the offending level. A second
 * copy of the contiguity rules here would be a second implementation to drift.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

interface Band {
  grade: string;
  min: number;
  max: number;
  label: string;
  remark?: string;
}

interface LevelOverride {
  promotion_cutoff?: number;
  grading_scale?: Band[];
}

interface LevelsPayload {
  levels: Array<{ level: string; class_names: string[] }>;
  school_wide: { promotion_cutoff: number | null; grading_scale: Band[] };
  level_overrides: Record<string, LevelOverride>;
  orphaned_overrides: string[];
  near_duplicate_levels: string[][];
}

/** One level's editable state. `custom*` false means "same as school-wide" — absent from the map. */
interface Draft {
  customCutoff: boolean;
  cutoff: string;
  customScale: boolean;
  scale: Band[];
}

function draftFrom(override: LevelOverride | undefined): Draft {
  return {
    customCutoff: typeof override?.promotion_cutoff === 'number',
    cutoff: typeof override?.promotion_cutoff === 'number' ? String(override.promotion_cutoff) : '',
    customScale: Array.isArray(override?.grading_scale),
    scale: override?.grading_scale ? override.grading_scale.map(b => ({ ...b })) : [],
  };
}

function copyBands(bands: Band[]): Band[] {
  return bands.length > 0
    ? bands.map(b => ({ ...b }))
    : [{ grade: 'A', min: 0, max: 100, label: '', remark: '' }];
}

function describeScale(bands: Band[]): string {
  if (bands.length === 0) return 'none set';
  return [...bands].sort((a, b) => b.min - a.min).map(b => `${b.grade} ${b.min}–${b.max}`).join(', ');
}

export default function LevelGradingPage() {
  const { schoolId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<LevelsPayload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [keepOrphans, setKeepOrphans] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; warnings: string[] } | null>(null);

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch<{ success: boolean; data: LevelsPayload }>(
        `/api/schools/${schoolId}/academic-config/levels`,
        { cache: 'no-store' }
      );
      setData(res.data);
      setDrafts(Object.fromEntries(res.data.levels.map(l => [l.level, draftFrom(res.data.level_overrides[l.level])])));
      setKeepOrphans(Object.fromEntries(res.data.orphaned_overrides.map(k => [k, true])));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load level settings');
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => { void load(); }, [load]);

  function update(level: string, change: Partial<Draft>) {
    setDrafts(prev => ({ ...prev, [level]: { ...prev[level], ...change } }));
    setNotice(null);
  }

  function updateBand(level: string, index: number, change: Partial<Band>) {
    setDrafts(prev => {
      const scale = prev[level].scale.map((b, i) => (i === index ? { ...b, ...change } : b));
      return { ...prev, [level]: { ...prev[level], scale } };
    });
    setNotice(null);
  }

  /** The full map to send. Built from every level shown PLUS every orphan still kept. */
  function buildOverrides(): { map: Record<string, LevelOverride>; error: string | null } {
    const map: Record<string, LevelOverride> = {};
    for (const [level, draft] of Object.entries(drafts)) {
      const entry: LevelOverride = {};
      if (draft.customCutoff) {
        const n = Number(draft.cutoff);
        if (draft.cutoff.trim() === '' || !Number.isInteger(n) || n < 0 || n > 100) {
          return { map, error: `${level}: the pass mark must be a whole number from 0 to 100.` };
        }
        entry.promotion_cutoff = n;
      }
      if (draft.customScale) {
        entry.grading_scale = draft.scale.map(b => ({
          grade: b.grade.trim(),
          min: Number(b.min),
          max: Number(b.max),
          label: b.label.trim(),
          remark: (b.remark ?? '').trim(),
        }));
      }
      if (Object.keys(entry).length > 0) map[level] = entry;
    }
    for (const orphan of data?.orphaned_overrides ?? []) {
      if (keepOrphans[orphan] && data?.level_overrides[orphan]) map[orphan] = data.level_overrides[orphan];
    }
    return { map, error: null };
  }

  async function save() {
    if (!schoolId) return;
    const { map, error } = buildOverrides();
    if (error) { setSaveError(error); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch<{ success: boolean; data: { message: string; warnings?: string[] } }>(
        `/api/schools/${schoolId}/academic-config`,
        { method: 'PATCH', body: JSON.stringify({ level_overrides: map }) }
      );
      // Re-read rather than trusting local state, so what is shown is what was stored.
      await load();
      setNotice({ message: 'Saved', warnings: res.data.warnings ?? [] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  if (loadError) {
    return (
      <div className="p-8 max-w-3xl">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{loadError}</div>
      </div>
    );
  }
  if (!data) return null;

  const schoolCutoff = data.school_wide.promotion_cutoff;

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">Grading by Level</h1>
        <p className="text-sm text-gray-500 mt-1">
          Give a level — for example your primary or secondary section — its own pass mark or grading scale. A level
          left on <em>Same as school-wide</em> follows the settings on{' '}
          <Link href="/settings/grading-scale" className="text-[#003366] underline">Grading Scale</Link>, including
          any later changes to them.
        </p>
      </div>

      {data.levels.length === 0 && (
        <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          None of your classes has a level set, so there is nothing to override yet. Set each class&rsquo;s level under{' '}
          <Link href="/settings/roster" className="underline">Roster</Link>.
        </div>
      )}

      {data.near_duplicate_levels.length > 0 && (
        <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          <p className="font-medium">Some levels look the same but are spelled differently:</p>
          <ul className="list-disc ml-5 mt-1">
            {data.near_duplicate_levels.map(group => (
              <li key={group.join('|')}>{group.map(l => `“${l}”`).join(' and ')}</li>
            ))}
          </ul>
          <p className="mt-1">
            They are treated as different levels, so a setting on one does not reach the other&rsquo;s classes. Make
            them match under <Link href="/settings/roster" className="underline">Roster</Link>.
          </p>
        </div>
      )}

      {data.orphaned_overrides.length > 0 && (
        <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          <p className="font-medium">Settings for levels no class uses:</p>
          <p className="mt-1">These are saved but apply to nobody. They are kept unless you remove them.</p>
          <ul className="mt-2 space-y-1">
            {data.orphaned_overrides.map(orphan => (
              <li key={orphan} className="flex items-center justify-between gap-3">
                <span className={keepOrphans[orphan] ? '' : 'line-through opacity-60'}>
                  “{orphan}” — {JSON.stringify(data.level_overrides[orphan])}
                </span>
                <button
                  type="button"
                  onClick={() => setKeepOrphans(prev => ({ ...prev, [orphan]: !prev[orphan] }))}
                  className="shrink-0 rounded border border-amber-300 px-2 py-0.5 text-xs"
                >
                  {keepOrphans[orphan] ? 'Remove on save' : 'Keep'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-4">
        {data.levels.map(({ level, class_names }) => {
          const d = drafts[level];
          if (!d) return null;
          return (
            <section key={level} className="bg-white rounded-lg shadow-sm p-5">
              <h2 className="font-semibold text-gray-900">{level}</h2>
              <p className="text-xs text-gray-500 mt-0.5">{class_names.join(', ')}</p>

              <fieldset className="mt-4">
                <legend className="text-sm font-medium text-gray-700">Pass mark</legend>
                <label className="flex items-center gap-2 text-sm mt-1">
                  <input type="radio" checked={!d.customCutoff} onChange={() => update(level, { customCutoff: false })} />
                  Same as school-wide ({schoolCutoff === null ? 'none set' : `${schoolCutoff}%`})
                </label>
                <label className="flex items-center gap-2 text-sm mt-1">
                  <input type="radio" checked={d.customCutoff} onChange={() => update(level, { customCutoff: true })} />
                  Its own pass mark
                  {d.customCutoff && (
                    <input
                      type="number" min={0} max={100} step={1}
                      value={d.cutoff}
                      onChange={e => update(level, { cutoff: e.target.value })}
                      className="ml-2 w-20 rounded border border-gray-300 px-2 py-1 text-sm"
                      aria-label={`${level} pass mark`}
                    />
                  )}
                  {d.customCutoff && <span className="text-xs text-gray-500">%</span>}
                </label>
                {d.customCutoff && (
                  <p className="text-xs text-gray-500 mt-1 ml-6">
                    Fixed for this level — it will not change when the school-wide pass mark does.
                  </p>
                )}
              </fieldset>

              <fieldset className="mt-4">
                <legend className="text-sm font-medium text-gray-700">Grading scale</legend>
                <label className="flex items-center gap-2 text-sm mt-1">
                  <input type="radio" checked={!d.customScale} onChange={() => update(level, { customScale: false })} />
                  Same as school-wide ({describeScale(data.school_wide.grading_scale)})
                </label>
                <label className="flex items-center gap-2 text-sm mt-1">
                  <input
                    type="radio"
                    checked={d.customScale}
                    onChange={() =>
                      update(level, {
                        customScale: true,
                        // A starting point the user then edits — choosing "its own scale"
                        // is the explicit act that pins it, so copying here infers nothing.
                        scale: d.scale.length > 0 ? d.scale : copyBands(data.school_wide.grading_scale),
                      })
                    }
                  />
                  Its own grading scale
                </label>

                {d.customScale && (
                  <div className="mt-2 ml-6">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-gray-500">
                          <th className="pb-1 pr-2">Grade</th><th className="pb-1 pr-2">From</th><th className="pb-1 pr-2">To</th>
                          <th className="pb-1 pr-2">Label</th><th className="pb-1 pr-2">Remark</th><th />
                        </tr>
                      </thead>
                      <tbody>
                        {d.scale.map((b, i) => (
                          <tr key={i}>
                            <td className="pr-2 py-0.5"><input value={b.grade} maxLength={5} onChange={e => updateBand(level, i, { grade: e.target.value })} className="w-14 rounded border border-gray-300 px-1.5 py-0.5" /></td>
                            <td className="pr-2 py-0.5"><input type="number" min={0} max={100} value={b.min} onChange={e => updateBand(level, i, { min: Number(e.target.value) })} className="w-16 rounded border border-gray-300 px-1.5 py-0.5" /></td>
                            <td className="pr-2 py-0.5"><input type="number" min={0} max={100} value={b.max} onChange={e => updateBand(level, i, { max: Number(e.target.value) })} className="w-16 rounded border border-gray-300 px-1.5 py-0.5" /></td>
                            <td className="pr-2 py-0.5"><input value={b.label} onChange={e => updateBand(level, i, { label: e.target.value })} className="w-28 rounded border border-gray-300 px-1.5 py-0.5" /></td>
                            <td className="pr-2 py-0.5"><input value={b.remark ?? ''} onChange={e => updateBand(level, i, { remark: e.target.value })} className="w-28 rounded border border-gray-300 px-1.5 py-0.5" /></td>
                            <td className="py-0.5">
                              <button
                                type="button"
                                disabled={d.scale.length === 1}
                                onClick={() => update(level, { scale: d.scale.filter((_, j) => j !== i) })}
                                className="text-xs text-red-700 disabled:opacity-40"
                              >Remove</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button
                      type="button"
                      onClick={() => update(level, { scale: [...d.scale, { grade: '', min: 0, max: 0, label: '', remark: '' }] })}
                      className="mt-2 text-xs text-[#003366] underline"
                    >Add a band</button>
                    <p className="text-xs text-gray-500 mt-1">
                      Bands must run from 0 to 100 without gaps or overlaps. Fixed for this level — it will not change when
                      the school-wide scale does.
                    </p>
                  </div>
                )}
              </fieldset>
            </section>
          );
        })}
      </div>

      {saveError && (
        <div className="mt-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{saveError}</div>
      )}
      {notice && (
        <div className="mt-6 rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          <p>{notice.message}</p>
          {notice.warnings.map(w => <p key={w} className="mt-1 text-amber-800">{w}</p>)}
        </div>
      )}

      {/* Orphans alone still need a Save, or a school with no levels left could never remove them. */}
      {(data.levels.length > 0 || data.orphaned_overrides.length > 0) && (
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="mt-6 rounded-lg bg-[#003366] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </div>
  );
}
