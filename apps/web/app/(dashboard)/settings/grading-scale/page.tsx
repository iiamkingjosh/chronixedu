'use client';

import { useEffect, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import { COMMON_SCALE, initialGradingForm, parsePassMark } from '@/lib/gradingDefaults';

// ── Schema ────────────────────────────────────────────────────────────────────

const bandSchema = z.object({
  grade: z.string().min(1, 'Grade is required').max(5),
  min:   z.coerce.number().min(0).max(100),
  max:   z.coerce.number().min(0).max(100),
  label: z.string().min(1, 'Label is required'),
  remark: z.string().optional().or(z.literal('')),
});

const formSchema = z.object({
  bands: z
    .array(bandSchema)
    .min(1, 'At least one grade band is required')
    .superRefine((bands, ctx) => {
      // Sort by min descending to validate coverage
      const sorted = [...bands].sort((a, b) => b.min - a.min);

      // Top band must have max = 100
      if (sorted[0].max !== 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'The highest grade band must have a max of 100',
          path: [],
        });
      }

      // Bottom band must have min = 0
      if (sorted[sorted.length - 1].min !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'The lowest grade band must have a min of 0',
          path: [],
        });
      }

      // Bands must be contiguous (each band's min = previous band's max + 1)
      for (let i = 0; i < sorted.length - 1; i++) {
        const current  = sorted[i];
        const next     = sorted[i + 1];
        if (current.min !== next.max + 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Bands must be contiguous: gap between ${next.grade} (max ${next.max}) and ${current.grade} (min ${current.min})`,
            path: [],
          });
        }
      }

      // Each band min <= max
      bands.forEach((band, i) => {
        if (band.min > band.max) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Band ${band.grade}: min cannot exceed max`,
            path: [`${i}.min`],
          });
        }
      });
    }),
});

type FormValues = z.output<typeof formSchema>;
type FormValuesInput = z.input<typeof formSchema>;

// ── Toast ─────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function GradingScalePage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [warnings, setWarnings]         = useState<string[]>([]);
  const [warningsConfirmed, setWarningsConfirmed] = useState(false);
  // Nothing is shown as set until the school has saved it (doctrine 8): the form opens empty.
  const [scaleSet, setScaleSet]         = useState(false);
  const [passMark, setPassMark]         = useState('');
  const [passMarkSet, setPassMarkSet]   = useState(false);
  const [passMarkError, setPassMarkError] = useState<string | null>(null);
  const [savingPassMark, setSavingPassMark] = useState(false);

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValuesInput, unknown, FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { bands: [] },
  });

  const { fields, append, remove, replace } = useFieldArray({ control, name: 'bands' });

  // Load existing scale
  useEffect(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: { academic_config?: { grading_scale?: unknown; promotion_cutoff?: unknown } } }>(
      `/api/schools/${schoolId}`
    )
      .then(({ data }) => {
        const start = initialGradingForm(data.academic_config);
        reset({ bands: start.bands });
        setScaleSet(start.scaleSet);
        setPassMark(start.passMark);
        setPassMarkSet(start.passMarkSet);
      })
      .catch(() => show('Failed to load grading scale', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  async function onSubmit(values: FormValues) {
    if (!schoolId) return;
    setSaving(true);
    setWarningsConfirmed(false);
    try {
      const res = await apiFetch<{ success: boolean; data: { message: string; warnings: string[] } }>(
        `/api/schools/${schoolId}/academic-config`,
        {
          method: 'PATCH',
          body: JSON.stringify({ grading_scale: values.bands }),
        }
      );
      setWarnings(res.data.warnings ?? []);
      setScaleSet(true);
      show('Grading scale saved');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function savePassMark() {
    if (!schoolId) return;
    const parsed = parsePassMark(passMark);
    if (!parsed.ok) { setPassMarkError(parsed.message); return; }
    setPassMarkError(null);
    setSavingPassMark(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/academic-config`, {
        method: 'PATCH',
        body: JSON.stringify({ promotion_cutoff: parsed.value }),
      });
      setPassMark(String(parsed.value));
      setPassMarkSet(true);
      show('Pass mark saved');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSavingPassMark(false);
    }
  }

  function addBand() {
    append({ grade: '', min: 0, max: 0, label: '', remark: '' });
  }

  const bandsError = errors.bands?.root?.message ?? (errors.bands as { message?: string } | undefined)?.message;

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-64">
        <div className="text-gray-500 text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <h1 className="text-xl font-semibold text-gray-900 mb-1">School-wide Grading</h1>
      <p className="text-sm text-gray-500 mb-8">Used by every class unless Grading by Level says otherwise. Bands must cover 0–100 without gaps or overlaps.</p>

      {/* Warnings banner + confirmation gate */}
      {warnings.length > 0 && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 space-y-3">
          <p className="text-sm font-semibold text-amber-800">
            Changes saved — but existing results may be affected:
          </p>
          <ul className="list-disc list-inside space-y-0.5">
            {warnings.map((w, i) => (
              <li key={i} className="text-sm text-amber-700">{w}</li>
            ))}
          </ul>
          <label className="flex items-start gap-3 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={warningsConfirmed}
              onChange={e => setWarningsConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-amber-400 accent-amber-600 cursor-pointer"
            />
            <span className="text-sm text-amber-800 font-medium">
              I understand the implications and want to make further changes
            </span>
          </label>
        </div>
      )}

      {!scaleSet && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
          <p className="text-sm font-semibold text-amber-800">Grading scale: not set</p>
          <p className="text-sm text-amber-700 mt-1">
            This school has no grading scale yet, so results cannot be published. Add your grade bands below and
            save them{fields.length === 0 ? ', or start from a common scale and change it to match your school' : ''}.
          </p>
          {fields.length === 0 && (
            <button
              type="button"
              onClick={() => replace(COMMON_SCALE)}
              className="mt-3 px-4 py-2 bg-white border border-amber-300 text-amber-900 text-sm font-medium rounded-lg hover:bg-amber-100"
            >
              Start from a common scale (A to F)
            </button>
          )}
          {fields.length > 0 && (
            <p className="text-xs text-amber-700 mt-2">Nothing is saved until you press Save Grading Scale.</p>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto mb-6">
          {/* Table header */}
          <div className="grid grid-cols-[80px_80px_80px_1fr_1fr_40px] gap-3 px-5 py-3 bg-gray-50 border-b border-gray-200 min-w-[560px]">
            {['Grade', 'Min', 'Max', 'Label', 'Remark', ''].map((h, i) => (
              <span key={i} className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</span>
            ))}
          </div>

          {/* Rows */}
          <div className="divide-y divide-gray-100">
            {fields.map((field, index) => (
              <div key={field.id} className="grid grid-cols-[80px_80px_80px_1fr_1fr_40px] gap-3 px-5 py-3 items-start min-w-[560px]">
                {/* Grade */}
                <div>
                  <input
                    {...register(`bands.${index}.grade`)}
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 font-mono uppercase"
                    placeholder="A"
                    maxLength={5}
                  />
                  {errors.bands?.[index]?.grade && (
                    <p className="text-xs text-red-600 mt-0.5">{errors.bands[index]?.grade?.message}</p>
                  )}
                </div>

                {/* Min */}
                <div>
                  <Controller
                    control={control}
                    name={`bands.${index}.min`}
                    render={({ field: f }) => (
                      <input
                        {...f}
                        value={f.value as number}
                        type="number"
                        min={0}
                        max={100}
                        className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                        placeholder="0"
                      />
                    )}
                  />
                  {errors.bands?.[index]?.min && (
                    <p className="text-xs text-red-600 mt-0.5">{errors.bands[index]?.min?.message}</p>
                  )}
                </div>

                {/* Max */}
                <div>
                  <Controller
                    control={control}
                    name={`bands.${index}.max`}
                    render={({ field: f }) => (
                      <input
                        {...f}
                        value={f.value as number}
                        type="number"
                        min={0}
                        max={100}
                        className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                        placeholder="100"
                      />
                    )}
                  />
                  {errors.bands?.[index]?.max && (
                    <p className="text-xs text-red-600 mt-0.5">{errors.bands[index]?.max?.message}</p>
                  )}
                </div>

                {/* Label */}
                <div>
                  <input
                    {...register(`bands.${index}.label`)}
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                    placeholder="Distinction"
                  />
                  {errors.bands?.[index]?.label && (
                    <p className="text-xs text-red-600 mt-0.5">{errors.bands[index]?.label?.message}</p>
                  )}
                </div>

                {/* Remark */}
                <div>
                  <input
                    {...register(`bands.${index}.remark`)}
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                    placeholder="Excellent"
                  />
                </div>

                {/* Delete */}
                <div className="flex items-center justify-center pt-1">
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    className="text-gray-300 hover:text-red-500 transition-colors"
                    title="Remove band"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Add row */}
          <div className="px-5 py-3 border-t border-gray-100">
            <button
              type="button"
              onClick={addBand}
              className="text-sm text-slate-600 hover:text-slate-900 font-medium flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Grade Band
            </button>
          </div>
        </div>

        {/* Validation error */}
        {bandsError && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            <p className="text-sm text-red-700">{bandsError}</p>
          </div>
        )}

        {/* Coverage hint */}
        <p className="text-xs text-gray-400 mb-6">
          Bands must be contiguous and together cover exactly 0–100. Example: F (0–39), D (40–49), C (50–59), B (60–74), A (75–100).
        </p>

        <div className="flex items-center justify-end gap-4">
          {warnings.length > 0 && !warningsConfirmed && (
            <p className="text-xs text-amber-700">Check the box above to save again</p>
          )}
          <button
            type="submit"
            disabled={saving || (warnings.length > 0 && !warningsConfirmed)}
            className="px-6 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Grading Scale'}
          </button>
        </div>
      </form>

      {/* Pass mark — the school-wide one. A level can have its own on Grading by Level. */}
      <section className="mt-10 bg-white rounded-xl border border-gray-200 px-5 py-5">
        <h2 className="text-base font-semibold text-gray-900">Pass mark</h2>
        <p className="text-sm text-gray-500 mt-1">
          The average a student needs to pass the term, used on report cards and class results. Grading by Level can
          set a different pass mark for a level.
        </p>
        {!passMarkSet && (
          <p className="text-sm text-amber-700 mt-3">Not set: this school has not chosen a pass mark.</p>
        )}
        <div className="mt-4 flex items-start gap-3">
          <div>
            <label htmlFor="pass-mark" className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Pass mark (%)
            </label>
            <input
              id="pass-mark"
              type="text"
              inputMode="numeric"
              value={passMark}
              onChange={e => { setPassMark(e.target.value); setPassMarkError(null); }}
              className="w-28 border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              placeholder="e.g. 40"
            />
            {passMarkError && <p className="text-xs text-red-600 mt-1">{passMarkError}</p>}
          </div>
          <button
            type="button"
            onClick={savePassMark}
            disabled={savingPassMark}
            className="mt-5 px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {savingPassMark ? 'Saving…' : 'Save Pass Mark'}
          </button>
        </div>
      </section>
    </div>
  );
}
