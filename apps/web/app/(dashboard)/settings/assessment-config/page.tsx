'use client';

import { useEffect, useState, useCallback } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import type {
  Control, FieldErrors, FieldArrayWithId, UseFieldArrayAppend, UseFieldArrayRemove, UseFormRegister,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Domain types ───────────────────────────────────────────────────────────────

interface Component {
  id?: string;
  name: string;
  max_score: number;
  weight_percent: number;
  display_order: number;
}

interface AssessmentConfig {
  id: string;
  term_id: string;
  term_name: string | null;
  subject_id: string | null;
  subject_name: string | null;
  class_level: string | null;
  is_default: boolean;
  is_locked: boolean;
  components: Component[];
}

interface ResolvedConfig extends AssessmentConfig {
  priority_level: 1 | 2 | 3 | 4;
}

interface Term    { id: string; name: string; session_name?: string }
interface Subject { id: string; name: string; code: string }
interface ClassRow{ id: string; name: string; level: string }

// ── Schemas ────────────────────────────────────────────────────────────────────

const SCOPES = ['default', 'subject', 'level', 'subject_level'] as const;
type Scope = (typeof SCOPES)[number];

const compRowSchema = z.object({
  name:           z.string().min(1, 'Required'),
  max_score:      z.coerce.number().positive('Must be > 0'),
  weight_percent: z.coerce.number().min(0.01, 'Must be > 0'),
});

// Create form schema — weight total validated here for the error display;
// the save button is *also* disabled via the live `total` state for instant feedback.
const createSchema = z
  .object({
    term_id:     z.string().uuid('Select a term'),
    scope:       z.enum(SCOPES),
    subject_id:  z.string().optional(),
    class_level: z.string().optional(),
    components:  z.array(compRowSchema).min(1, 'Add at least one component'),
  })
  .superRefine((d, ctx) => {
    if ((d.scope === 'subject' || d.scope === 'subject_level') && !d.subject_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Select a subject', path: ['subject_id'] });
    }
    if ((d.scope === 'level' || d.scope === 'subject_level') && !d.class_level) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Select a class level', path: ['class_level'] });
    }
    const total = d.components.reduce((s, c) => s + Number(c.weight_percent), 0);
    if (Math.round(total * 100) !== 10000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Weights must total 100. Got ${total.toFixed(1)}`, path: ['components'] });
    }
  });
type CreateForm = z.output<typeof createSchema>;
type CreateFormInput = z.input<typeof createSchema>;

const editSchema = z.object({
  components: z.array(compRowSchema).min(1),
});
type EditForm = z.output<typeof editSchema>;
type EditFormInput = z.input<typeof editSchema>;

// ── Toast ──────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const show = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);
  return { toast, show };
}

// ── Helper functions ───────────────────────────────────────────────────────────

function scopeLabel(c: AssessmentConfig): string {
  if (c.is_default) return 'School Default';
  if (c.subject_id && c.class_level) return `${c.subject_name ?? '—'} + ${c.class_level}`;
  if (c.subject_id) return c.subject_name ?? c.subject_id;
  if (c.class_level) return `Level: ${c.class_level}`;
  return 'Custom';
}

function scopeDescription(c: AssessmentConfig): string {
  if (c.is_default) return 'All classes and subjects';
  if (c.subject_id && c.class_level) return `${c.subject_name ?? '—'} — ${c.class_level} only`;
  if (c.subject_id) return `${c.subject_name ?? '—'} — any level`;
  if (c.class_level) return `${c.class_level} — any subject`;
  return '—';
}

function compSummary(comps: Component[]): string {
  return [...comps]
    .sort((a, b) => a.display_order - b.display_order)
    .map(c => `${c.name} ${c.weight_percent}%`)
    .join(', ');
}

function priorityReason(c: ResolvedConfig, subject: string | null): string {
  switch (c.priority_level) {
    case 1: return `Exact match — scoped to ${subject ?? 'this subject'} in ${c.class_level ?? 'this level'}`;
    case 2: return `Subject match — ${subject ?? 'this subject'} applies across all class levels`;
    case 3: return `Class level match — all subjects at ${c.class_level ?? 'this level'}`;
    case 4: return 'School default — fallback; no more-specific config found';
  }
}

// ── Weight bar ─────────────────────────────────────────────────────────────────

function WeightBar({ total }: { total: number }) {
  const exact = Math.round(total * 100) === 10000;
  const over  = total > 100;
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-150 ${exact ? 'bg-green-500' : over ? 'bg-red-500' : 'bg-red-400'}`}
          style={{ width: `${Math.min(total, 100)}%` }}
        />
      </div>
      <span className={`text-sm font-semibold tabular-nums w-32 text-right ${exact ? 'text-green-600' : 'text-red-600'}`}>
        {total.toFixed(1)}% {exact ? '✓' : '— must be 100'}
      </span>
    </div>
  );
}

// ── Component rows (receives total from parent via prop — no internal watch) ───

interface CompRowsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields:    FieldArrayWithId<any, 'components', 'id'>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  append:    UseFieldArrayAppend<any, 'components'>;
  remove:    UseFieldArrayRemove;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control:   Control<any, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register:  UseFormRegister<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errors:    FieldErrors<any>;
  total:     number;
  isLocked?: boolean;
}

function CompRows({ fields, append, remove, control, register, errors, total, isLocked }: CompRowsProps) {
  const compErrors = errors?.components as
    | (Partial<Record<number, { name?: { message?: string } }>> & { root?: { message?: string }; message?: string })
    | undefined;
  const rootMsg = compErrors?.root?.message ?? compErrors?.message ?? '';

  const inp = (locked?: boolean) =>
    `w-full border rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 ${
      locked ? 'border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed' : 'border-gray-200'
    }`;

  return (
    <div className="space-y-3">
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-24">Max Score</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-24">Weight %</th>
              {!isLocked && <th className="w-8" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {fields.map((field, i) => (
              <tr key={field.id} className="group">
                <td className="px-3 py-2">
                  <input
                    {...register(`components.${i}.name`)}
                    disabled={isLocked}
                    className={inp(isLocked)}
                    placeholder="e.g. CA Test"
                  />
                  {compErrors?.[i]?.name && (
                    <p className="text-xs text-red-600 mt-0.5">{compErrors[i]?.name?.message}</p>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Controller
                    control={control}
                    name={`components.${i}.max_score`}
                    render={({ field: f }) => (
                      <input {...f} value={f.value as number} type="number" min={1} disabled={isLocked} className={inp(isLocked)} />
                    )}
                  />
                </td>
                <td className="px-3 py-2">
                  <Controller
                    control={control}
                    name={`components.${i}.weight_percent`}
                    render={({ field: f }) => (
                      <input {...f} value={f.value as number} type="number" min={0.01} max={100} step={0.01} disabled={isLocked} className={inp(isLocked)} />
                    )}
                  />
                </td>
                {!isLocked && (
                  <td className="px-2 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      className="text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {fields.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-xs text-gray-400">
                  No components — add one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {!isLocked && (
        <button
          type="button"
          onClick={() => append({ name: '', max_score: 100, weight_percent: 0 })}
          className="text-xs font-medium text-slate-600 hover:text-slate-900 flex items-center gap-1.5"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Component
        </button>
      )}

      <WeightBar total={total} />
      {rootMsg && <p className="text-xs text-red-600">{rootMsg}</p>}
    </div>
  );
}

// ── Modal wrapper ──────────────────────────────────────────────────────────────

function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 overflow-y-auto">
      <div className={`bg-white rounded-xl shadow-xl w-full my-4 ${wide ? 'max-w-2xl' : 'max-w-lg'}`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ── Create modal ───────────────────────────────────────────────────────────────

const SCOPE_LABELS: Record<Scope, string> = {
  default:       'School-wide (default)',
  subject:       'Specific subject',
  level:         'Specific class level',
  subject_level: 'Subject + class level',
};

function CreateModal({
  schoolId, terms, subjects, classLevels, onClose, onCreated,
}: {
  schoolId: string;
  terms: Term[];
  subjects: Subject[];
  classLevels: string[];
  onClose: () => void;
  onCreated: (c: AssessmentConfig) => void;
}) {
  const {
    register, control, handleSubmit, watch,
    formState: { errors, isSubmitting },
  } = useForm<CreateFormInput, unknown, CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      scope: 'default',
      components: [
        { name: 'CA', max_score: 30, weight_percent: 30 },
        { name: 'Exam', max_score: 100, weight_percent: 70 },
      ],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'components' });

  const scope      = watch('scope');
  const components = watch('components');
  const total      = components?.reduce((s, c) => s + (Number(c.weight_percent) || 0), 0) ?? 0;
  const weightOk   = Math.round(total * 100) === 10000;

  const [apiError, setApiError] = useState('');

  async function onSubmit(values: CreateForm) {
    setApiError('');
    try {
      const body: Record<string, unknown> = {
        term_id:     values.term_id,
        is_default:  values.scope === 'default',
        subject_id:  (values.scope === 'subject' || values.scope === 'subject_level') ? values.subject_id : null,
        class_level: (values.scope === 'level'   || values.scope === 'subject_level') ? values.class_level : null,
        components:  values.components.map((c, i) => ({ ...c, display_order: i + 1 })),
      };
      const res = await apiFetch<{ success: boolean; data: AssessmentConfig }>(
        `/api/schools/${schoolId}/assessment-config`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      onCreated(res.data);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Create failed');
    }
  }

  const sel = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white';

  return (
    <Modal title="New Assessment Configuration" onClose={onClose} wide>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        {/* Term */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Term</label>
          <select {...register('term_id')} className={sel} defaultValue="">
            <option value="" disabled>Select a term…</option>
            {terms.map(t => (
              <option key={t.id} value={t.id}>
                {t.session_name ? `${t.session_name} — ${t.name}` : t.name}
              </option>
            ))}
          </select>
          {errors.term_id && <p className="mt-1 text-xs text-red-600">{errors.term_id.message}</p>}
        </div>

        {/* Scope */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Scope</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {SCOPES.map(s => (
              <label
                key={s}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border cursor-pointer text-sm transition-colors ${
                  scope === s
                    ? 'border-slate-700 bg-slate-50 text-slate-900 font-medium'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                <input type="radio" {...register('scope')} value={s} className="sr-only" />
                <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-colors ${
                  scope === s ? 'border-slate-700 bg-slate-700' : 'border-gray-300'
                }`} />
                {SCOPE_LABELS[s]}
              </label>
            ))}
          </div>
        </div>

        {/* Subject dropdown */}
        {(scope === 'subject' || scope === 'subject_level') && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
            <select {...register('subject_id')} className={sel} defaultValue="">
              <option value="" disabled>Select a subject…</option>
              {subjects.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
              ))}
            </select>
            {errors.subject_id && <p className="mt-1 text-xs text-red-600">{errors.subject_id.message}</p>}
          </div>
        )}

        {/* Class level dropdown */}
        {(scope === 'level' || scope === 'subject_level') && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Class Level</label>
            <select {...register('class_level')} className={sel} defaultValue="">
              <option value="" disabled>Select a class level…</option>
              {classLevels.map(l => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
            {errors.class_level && <p className="mt-1 text-xs text-red-600">{errors.class_level.message}</p>}
          </div>
        )}

        {/* Components */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Score Components</label>
          <CompRows
            fields={fields}
            append={append}
            remove={remove}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            control={control as unknown as Control<any, any, any>}
            register={register}
            errors={errors}
            total={total}
          />
        </div>

        {apiError && <p className="text-sm text-red-600">{apiError}</p>}

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || !weightOk}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSubmitting ? 'Creating…' : 'Create Config'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Edit modal ─────────────────────────────────────────────────────────────────

function EditModal({
  config, schoolId, onClose, onSaved,
}: {
  config: AssessmentConfig;
  schoolId: string;
  onClose: () => void;
  onSaved: (updated: AssessmentConfig) => void;
}) {
  const {
    register, control, handleSubmit, watch,
    formState: { errors, isSubmitting },
  } = useForm<EditFormInput, unknown, EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      components: config.components.map(c => ({
        name:           c.name,
        max_score:      c.max_score,
        weight_percent: c.weight_percent,
      })),
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'components' });

  const components = watch('components');
  const total      = components?.reduce((s, c) => s + (Number(c.weight_percent) || 0), 0) ?? 0;
  const weightOk   = Math.round(total * 100) === 10000;

  const [apiError, setApiError] = useState('');

  async function onSubmit(values: EditForm) {
    setApiError('');
    try {
      const res = await apiFetch<{ success: boolean; data: AssessmentConfig }>(
        `/api/schools/${schoolId}/assessment-config/${config.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            components: values.components.map((c, i) => ({ ...c, display_order: i + 1 })),
          }),
        }
      );
      onSaved({ ...res.data, term_name: config.term_name, subject_name: config.subject_name });
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <Modal title={`Edit — ${scopeLabel(config)}`} onClose={onClose} wide>
      {/* Locked banner */}
      {config.is_locked && (
        <div className="mb-5 flex items-start gap-2.5 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
          <svg className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-blue-800">Configuration locked</p>
            <p className="text-sm text-blue-700 mt-0.5">
              Scores have been entered for this term. Remove all scores for this term to unlock editing.
            </p>
          </div>
        </div>
      )}

      {/* Scope badges */}
      <div className="mb-5 flex flex-wrap gap-2">
        {config.term_name && (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
            {config.term_name}
          </span>
        )}
        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
          {scopeDescription(config)}
        </span>
        {config.is_locked && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Locked
          </span>
        )}
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Score Components</label>
          <CompRows
            fields={fields}
            append={append}
            remove={remove}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            control={control as unknown as Control<any, any, any>}
            register={register}
            errors={errors}
            total={total}
            isLocked={config.is_locked}
          />
        </div>

        {apiError && <p className="text-sm text-red-600">{apiError}</p>}

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
            Close
          </button>
          {!config.is_locked && (
            <button
              type="submit"
              disabled={isSubmitting || !weightOk}
              className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? 'Saving…' : 'Save Changes'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

// ── Resolution preview ─────────────────────────────────────────────────────────

function ResolutionPreview({
  schoolId, terms, subjects, classes,
}: {
  schoolId: string;
  terms: Term[];
  subjects: Subject[];
  classes: ClassRow[];
}) {
  const [classId,   setClassId]   = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [termId,    setTermId]    = useState('');
  const [result,    setResult]    = useState<ResolvedConfig | 'not_found' | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [apiError,  setApiError]  = useState('');

  async function test() {
    if (!classId || !subjectId || !termId) return;
    setLoading(true);
    setResult(null);
    setApiError('');
    try {
      const res = await apiFetch<{ success: boolean; data: ResolvedConfig }>(
        `/api/schools/${schoolId}/assessment-config/resolve?class_id=${classId}&subject_id=${subjectId}&term_id=${termId}`
      );
      setResult(res.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('NO_CONFIG') || msg.toLowerCase().includes('no assessment')) {
        setResult('not_found');
      } else {
        setApiError(msg || 'Resolution failed');
      }
    } finally {
      setLoading(false);
    }
  }

  const canTest = !!(classId && subjectId && termId);
  const resolvedSubject = subjects.find(s => s.id === subjectId)?.name ?? null;

  const sel = 'flex-1 min-w-36 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white';

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-900">Resolution Preview</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Test which config would apply for a specific class + subject + term combination
        </p>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Controls */}
        <div className="flex flex-wrap gap-3 items-end">
          <div className={sel.replace('flex-1 min-w-36 ', '')}>
            <label className="block text-xs font-medium text-gray-600 mb-1">Class</label>
            <select value={classId} onChange={e => { setClassId(e.target.value); setResult(null); }} className={sel}>
              <option value="">Select class…</option>
              {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className={sel.replace('flex-1 min-w-36 ', '')}>
            <label className="block text-xs font-medium text-gray-600 mb-1">Subject</label>
            <select value={subjectId} onChange={e => { setSubjectId(e.target.value); setResult(null); }} className={sel}>
              <option value="">Select subject…</option>
              {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className={sel.replace('flex-1 min-w-36 ', '')}>
            <label className="block text-xs font-medium text-gray-600 mb-1">Term</label>
            <select value={termId} onChange={e => { setTermId(e.target.value); setResult(null); }} className={sel}>
              <option value="">Select term…</option>
              {terms.map(t => (
                <option key={t.id} value={t.id}>
                  {t.session_name ? `${t.session_name} — ${t.name}` : t.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={test}
            disabled={!canTest || loading}
            className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            {loading ? 'Testing…' : 'Test Resolution'}
          </button>
        </div>

        {apiError && <p className="text-sm text-red-600">{apiError}</p>}

        {/* No match */}
        {result === 'not_found' && (
          <div className="border border-amber-200 bg-amber-50 rounded-lg px-4 py-3 flex items-start gap-2.5">
            <svg className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-amber-800">No configuration found</p>
              <p className="text-sm text-amber-700 mt-0.5">
                No config matches this combination for the selected term. Create a School-wide default for this term.
              </p>
            </div>
          </div>
        )}

        {/* Match found */}
        {result && result !== 'not_found' && (
          <div className="border border-green-200 bg-green-50 rounded-xl overflow-hidden">
            {/* Result header */}
            <div className="px-4 py-3 border-b border-green-100 flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 text-green-600 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-green-800">
                    Matched: <span className="font-bold">{scopeLabel(result)}</span>
                  </p>
                  <p className="text-xs text-green-700 mt-0.5">{priorityReason(result, resolvedSubject)}</p>
                </div>
              </div>
              <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold ${
                result.priority_level === 1 ? 'bg-green-200 text-green-800' :
                result.priority_level === 2 ? 'bg-blue-100 text-blue-800' :
                result.priority_level === 3 ? 'bg-purple-100 text-purple-800' :
                'bg-gray-100 text-gray-700'
              }`}>
                Priority {result.priority_level}
              </span>
            </div>

            {/* Components */}
            <div className="px-4 py-3">
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Score Components</p>
              <div className="flex flex-wrap gap-2">
                {[...result.components]
                  .sort((a, b) => a.display_order - b.display_order)
                  .map(c => (
                    <span
                      key={c.name}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-white border border-green-200 text-gray-700"
                    >
                      {c.name}
                      <span className="font-bold text-green-700">{c.weight_percent}%</span>
                      <span className="text-gray-400">/ {c.max_score}</span>
                    </span>
                  ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function AssessmentConfigPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [configs,    setConfigs]    = useState<AssessmentConfig[]>([]);
  const [terms,      setTerms]      = useState<Term[]>([]);
  const [subjects,   setSubjects]   = useState<Subject[]>([]);
  const [classes,    setClasses]    = useState<ClassRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editConfig, setEditConfig] = useState<AssessmentConfig | null>(null);

  const classLevels = [...new Set(classes.map(c => c.level))].sort();

  useEffect(() => {
    if (!schoolId) return;
    Promise.all([
      apiFetch<{ success: boolean; data: AssessmentConfig[] }>(`/api/schools/${schoolId}/assessment-config`),
      apiFetch<{ success: boolean; data: Array<{ id: string; name: string; terms: Term[] }> }>(`/api/schools/${schoolId}/sessions`),
      apiFetch<{ success: boolean; data: Subject[] }>(`/api/schools/${schoolId}/subjects`),
      apiFetch<{ success: boolean; data: ClassRow[] }>(`/api/schools/${schoolId}/classes`),
    ])
      .then(([cfgRes, sessRes, subjRes, clsRes]) => {
        setConfigs(cfgRes.data);
        const flat: Term[] = [];
        for (const sess of sessRes.data) {
          for (const t of sess.terms ?? []) {
            flat.push({ id: t.id, name: t.name, session_name: sess.name });
          }
        }
        setTerms(flat);
        setSubjects(subjRes.data);
        setClasses(clsRes.data);
      })
      .catch(() => show('Failed to load page data', false))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  function handleCreated(c: AssessmentConfig) {
    setConfigs(prev => [c, ...prev]);
    setShowCreate(false);
    show('Configuration created');
  }

  function handleSaved(updated: AssessmentConfig) {
    setConfigs(prev => prev.map(c => (c.id === updated.id ? updated : c)));
    setEditConfig(null);
    show('Configuration saved');
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-64">
        <div className="text-gray-500 text-sm">Loading…</div>
      </div>
    );
  }

  const lockedCount = configs.filter(c => c.is_locked).length;

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-8">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
          toast.ok ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 mb-1">Assessment Configuration</h1>
          <p className="text-sm text-gray-500">
            Define score components and weightings per term and scope.
            {lockedCount > 0 && (
              <span className="ml-1 text-blue-600">
                {lockedCount} {lockedCount === 1 ? 'config' : 'configs'} locked — scores entered.
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="shrink-0 px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 transition-colors"
        >
          + Create New Config
        </button>
      </div>

      {/* Config list table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {configs.length === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">
            No configurations yet. Create one to define how scores are structured for a term.
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Config Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Applies To</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Components</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {configs.map(cfg => (
                <tr key={cfg.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      {cfg.is_locked && (
                        <svg className="w-3.5 h-3.5 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                      )}
                      <div>
                        <p className="font-medium text-gray-900">{scopeLabel(cfg)}</p>
                        {cfg.term_name && (
                          <p className="text-xs text-gray-400 mt-0.5">{cfg.term_name}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{scopeDescription(cfg)}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate">
                    {cfg.components.length > 0 ? compSummary(cfg.components) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditConfig(cfg)}
                      className="text-sm font-medium text-slate-700 hover:text-slate-900 border border-slate-200 rounded-md px-3 py-1 hover:bg-slate-50 transition-colors"
                    >
                      {cfg.is_locked ? 'View' : 'Edit'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Resolution preview — only shown when classes and subjects exist */}
      {classes.length > 0 && subjects.length > 0 && (
        <ResolutionPreview
          schoolId={schoolId!}
          terms={terms}
          subjects={subjects}
          classes={classes}
        />
      )}

      {/* Modals */}
      {showCreate && schoolId && (
        <CreateModal
          schoolId={schoolId}
          terms={terms}
          subjects={subjects}
          classLevels={classLevels}
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
      {editConfig && schoolId && (
        <EditModal
          config={editConfig}
          schoolId={schoolId}
          onClose={() => setEditConfig(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
