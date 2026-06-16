'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  getSuperAdminSchool,
  exportSchoolData,
  createSubscription,
  updateSubscription,
  recordPayment,
  extendTrial,
  type SchoolDetail,
  type SchoolPlan,
  type SubscriptionStatus,
  type AuditLogEntry,
} from '@/lib/superAdminApi';
import { useToast } from '@/components/Toast';

type Tab = 'overview' | 'subscription' | 'users' | 'activity';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'subscription', label: 'Subscription' },
  { key: 'users', label: 'Users' },
  { key: 'activity', label: 'Activity' },
];

const USER_ROLES = ['principal', 'teacher', 'parent', 'student', 'registrar', 'bursar'] as const;

const ROLE_LABELS: Record<string, string> = {
  principal: 'Principal',
  teacher: 'Teacher',
  parent: 'Parent',
  student: 'Student',
  registrar: 'Registrar',
  bursar: 'Bursar',
};

const PLAN_LABELS: Record<SchoolPlan, string> = {
  basic: 'Basic',
  professional: 'Professional',
  enterprise: 'Enterprise',
  trial: 'Trial',
};

const SUB_STATUS_BADGE: Record<SubscriptionStatus, string> = {
  active: 'bg-green-50 text-green-700 border-green-200',
  suspended: 'bg-red-50 text-red-700 border-red-200',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-200',
  trial: 'bg-[#FF761B]/10 text-[#FF761B] border-[#FF761B]/30',
};

const ACTION_BADGE: Record<string, string> = {
  SCHOOL_SUSPENDED: 'bg-red-50 text-red-700 border-red-200',
  SCHOOL_REACTIVATED: 'bg-green-50 text-green-700 border-green-200',
  SCHOOL_ONBOARDED: 'bg-green-50 text-green-700 border-green-200',
  IMPERSONATION_START: 'bg-purple-50 text-purple-700 border-purple-200',
  IMPERSONATION_END: 'bg-purple-50 text-purple-700 border-purple-200',
  SUBSCRIPTION_CREATED: 'bg-blue-50 text-blue-700 border-blue-200',
  SUBSCRIPTION_UPDATED: 'bg-blue-50 text-blue-700 border-blue-200',
  MANUAL_PAYMENT_RECORDED: 'bg-blue-50 text-blue-700 border-blue-200',
  TRIAL_EXPIRED_AUTO_SUSPEND: 'bg-orange-50 text-orange-700 border-orange-200',
  SCHOOL_DATA_WIPED: 'bg-red-100 text-red-800 border-red-300 font-bold',
};

function formatNaira(value: number | null): string {
  if (value === null) return '—';
  return `₦${Math.round(value).toLocaleString('en-NG')}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatRelative(value: string): string {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

function StatusBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-green-50 text-green-700 border-green-200">Active</span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-red-50 text-red-700 border-red-200">Inactive</span>
  );
}

function SubStatusBadge({ status }: { status: SubscriptionStatus }) {
  const labels: Record<SubscriptionStatus, string> = {
    active: 'Active',
    suspended: 'Suspended',
    cancelled: 'Cancelled',
    trial: 'Trial',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${SUB_STATUS_BADGE[status]}`}>
      {labels[status]}
    </span>
  );
}

function ActionBadge({ actionType }: { actionType: string }) {
  const cls = ACTION_BADGE[actionType] ?? 'bg-gray-100 text-gray-600 border-gray-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${cls}`}>
      {actionType}
    </span>
  );
}

// ── Modal wrapper ─────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 max-h-[75vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';

// ── Create Subscription Modal ───────────────────────────────────────────────────

const createSubSchema = z.object({
  plan: z.enum(['basic', 'professional', 'enterprise', 'trial']),
  billing_cycle: z.enum(['monthly', 'annual']),
  amount_naira: z.coerce.number().min(0, 'Amount must be 0 or greater'),
  trial_ends_at: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.plan === 'trial' && !data.trial_ends_at) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Trial end date is required', path: ['trial_ends_at'] });
  }
});

type CreateSubFormInput = z.input<typeof createSubSchema>;
type CreateSubFormOutput = z.output<typeof createSubSchema>;

function CreateSubscriptionModal({ schoolId, onClose, onDone }: { schoolId: string; onClose: () => void; onDone: () => void }) {
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<CreateSubFormInput, unknown, CreateSubFormOutput>({
    resolver: zodResolver(createSubSchema),
    defaultValues: { plan: 'basic', billing_cycle: 'monthly', amount_naira: 0 },
  });
  const [apiError, setApiError] = useState('');
  const plan = watch('plan');

  async function onSubmit(values: CreateSubFormOutput) {
    setApiError('');
    try {
      await createSubscription({
        school_id: schoolId,
        plan: values.plan,
        billing_cycle: values.billing_cycle,
        amount_naira: values.amount_naira,
        ...(values.plan === 'trial' && values.trial_ends_at ? { trial_ends_at: values.trial_ends_at } : {}),
      });
      onDone();
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to create subscription');
    }
  }

  return (
    <Modal title="Create Subscription" onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Field label="Plan" error={errors.plan?.message}>
          <select {...register('plan')} className={inputClass}>
            <option value="basic">Basic</option>
            <option value="professional">Professional</option>
            <option value="enterprise">Enterprise</option>
            <option value="trial">Trial</option>
          </select>
        </Field>
        <Field label="Billing Cycle" error={errors.billing_cycle?.message}>
          <select {...register('billing_cycle')} className={inputClass}>
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
          </select>
        </Field>
        <Field label="Amount (₦)" error={errors.amount_naira?.message}>
          <input {...register('amount_naira')} type="number" min={0} step="0.01" className={inputClass} />
        </Field>
        {plan === 'trial' && (
          <Field label="Trial Ends At" error={errors.trial_ends_at?.message}>
            <input {...register('trial_ends_at')} type="date" className={inputClass} />
          </Field>
        )}
        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002244] disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Creating…' : 'Create Subscription'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Change Plan Modal ────────────────────────────────────────────────────────

const changePlanSchema = z.object({
  plan: z.enum(['basic', 'professional', 'enterprise', 'trial']),
});

type ChangePlanForm = z.infer<typeof changePlanSchema>;

function ChangePlanModal({ subscriptionId, currentPlan, onClose, onDone }: {
  subscriptionId: string;
  currentPlan: SchoolPlan;
  onClose: () => void;
  onDone: () => void;
}) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ChangePlanForm>({
    resolver: zodResolver(changePlanSchema),
    defaultValues: { plan: currentPlan },
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: ChangePlanForm) {
    setApiError('');
    try {
      await updateSubscription(subscriptionId, { plan: values.plan });
      onDone();
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to change plan');
    }
  }

  return (
    <Modal title="Change Plan" onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Field label="Plan" error={errors.plan?.message}>
          <select {...register('plan')} className={inputClass}>
            <option value="basic">Basic</option>
            <option value="professional">Professional</option>
            <option value="enterprise">Enterprise</option>
            <option value="trial">Trial</option>
          </select>
        </Field>
        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002244] disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Extend Trial Modal ───────────────────────────────────────────────────────

function ExtendTrialModal({ subscriptionId, onClose, onDone }: { subscriptionId: string; onClose: () => void; onDone: () => void }) {
  const [submitting, setSubmitting] = useState<7 | 14 | 30 | null>(null);
  const [apiError, setApiError] = useState('');

  async function handleExtend(days: 7 | 14 | 30) {
    setSubmitting(days);
    setApiError('');
    try {
      await extendTrial(subscriptionId, days);
      onDone();
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to extend trial');
      setSubmitting(null);
    }
  }

  return (
    <Modal title="Extend Trial" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-700">Choose how many days to extend the trial period:</p>
        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}
        <div className="flex gap-3">
          {[7, 14, 30].map((days) => (
            <button
              key={days}
              type="button"
              disabled={submitting !== null}
              onClick={() => handleExtend(days as 7 | 14 | 30)}
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:border-[#003366] hover:text-[#003366] disabled:opacity-50"
            >
              {submitting === days ? 'Extending…' : `+${days} days`}
            </button>
          ))}
        </div>
        <div className="flex justify-end pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Record Payment Modal ─────────────────────────────────────────────────────

const recordPaymentSchema = z.object({
  amount: z.coerce.number().min(1, 'Amount must be greater than 0'),
  reference: z.string().min(1, 'Reference is required'),
  payment_date: z.string().min(1, 'Payment date is required'),
  notes: z.string().optional(),
});

type RecordPaymentFormInput = z.input<typeof recordPaymentSchema>;
type RecordPaymentFormOutput = z.output<typeof recordPaymentSchema>;

function RecordPaymentModal({ subscriptionId, onClose, onDone }: { subscriptionId: string; onClose: () => void; onDone: () => void }) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<RecordPaymentFormInput, unknown, RecordPaymentFormOutput>({
    resolver: zodResolver(recordPaymentSchema),
    defaultValues: { payment_date: new Date().toISOString().slice(0, 10) },
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: RecordPaymentFormOutput) {
    setApiError('');
    try {
      await recordPayment(subscriptionId, {
        amount: values.amount,
        reference: values.reference,
        payment_date: values.payment_date,
        ...(values.notes ? { notes: values.notes } : {}),
      });
      onDone();
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to record payment');
    }
  }

  return (
    <Modal title="Record Payment" onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Field label="Amount (₦)" error={errors.amount?.message}>
          <input {...register('amount')} type="number" min={1} step="0.01" className={inputClass} />
        </Field>
        <Field label="Reference" error={errors.reference?.message}>
          <input {...register('reference')} className={inputClass} placeholder="Payment reference / receipt no." />
        </Field>
        <Field label="Payment Date" error={errors.payment_date?.message}>
          <input {...register('payment_date')} type="date" className={inputClass} />
        </Field>
        <Field label="Notes (optional)" error={errors.notes?.message}>
          <textarea {...register('notes')} rows={2} className={inputClass} />
        </Field>
        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002244] disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Recording…' : 'Record Payment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SuperAdminSchoolDetailPage() {
  const params = useParams<{ id: string }>();
  const schoolId = params.id;
  const searchParams = useSearchParams();
  const { show } = useToast();

  const [detail, setDetail] = useState<SchoolDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialTab = TABS.find((t) => t.key === searchParams.get('tab'))?.key ?? 'overview';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [exporting, setExporting] = useState(false);

  const [createSubOpen, setCreateSubOpen] = useState(false);
  const [changePlanOpen, setChangePlanOpen] = useState(false);
  const [extendTrialOpen, setExtendTrialOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getSuperAdminSchool(schoolId)
      .then(setDetail)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  async function handleExport() {
    if (!detail) return;
    setExporting(true);
    try {
      const blob = await exportSchoolData(schoolId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${detail.school.slug}-export.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to export school data', 'error');
    } finally {
      setExporting(false);
    }
  }

  async function handleSuspendBilling() {
    if (!detail?.subscription) return;
    if (!window.confirm('Suspend billing for this school? This sets the subscription status to suspended.')) return;
    try {
      await updateSubscription(detail.subscription.id, { subscription_status: 'suspended' });
      show('Billing suspended', 'success');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to suspend billing', 'error');
    }
  }

  if (loading) {
    return (
      <div className="p-8 max-w-6xl">
        <div className="h-6 w-40 bg-gray-200 rounded animate-pulse mb-6" />
        <div className="h-32 bg-white rounded-lg shadow-sm animate-pulse" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="p-8 max-w-6xl">
        <Link href="/super-admin/schools" className="text-sm text-[#003366] hover:underline">← Schools</Link>
        <div className="mt-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error ?? 'School not found'}</div>
      </div>
    );
  }

  const { school, subscription, user_counts, recent_activity } = detail;
  const studentCount = user_counts.find((u) => u.role === 'student')?.count ?? '0';

  return (
    <div className="p-8 max-w-6xl">
      <Link href="/super-admin/schools" className="text-sm text-[#003366] hover:underline">← Schools</Link>

      <div className="flex items-center gap-3 mt-3 mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">{school.name}</h1>
        <StatusBadge isActive={school.is_active} />
      </div>

      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`pb-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.key ? 'border-[#003366] text-[#003366]' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white rounded-lg shadow-sm p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-4">School Details</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Name</dt>
                <dd className="text-gray-900 text-right">{school.name}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Slug</dt>
                <dd className="text-gray-900 text-right font-mono">{school.slug}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Email</dt>
                <dd className="text-gray-900 text-right">{school.email ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Phone</dt>
                <dd className="text-gray-900 text-right">{school.phone ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Address</dt>
                <dd className="text-gray-900 text-right">{school.address ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Created</dt>
                <dd className="text-gray-900 text-right">{formatDate(school.created_at)}</dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting}
              className="mt-4 w-full bg-[#003366] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[#002244] disabled:opacity-50"
            >
              {exporting ? 'Exporting…' : 'Export Data'}
            </button>
          </div>

          <div className="bg-white rounded-lg shadow-sm p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-4">Settings Summary</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Subscription Tier</dt>
                <dd className="text-gray-900 text-right">{school.subscription_tier ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Current Plan</dt>
                <dd className="text-gray-900 text-right">{subscription ? PLAN_LABELS[subscription.plan] : '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Students</dt>
                <dd className="text-gray-900 text-right">{studentCount}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      {tab === 'subscription' && (
        <div className="bg-white rounded-lg shadow-sm p-5">
          {!subscription && (
            <div className="text-center py-8">
              <p className="text-sm text-gray-500 mb-4">No subscription found</p>
              <button
                type="button"
                onClick={() => setCreateSubOpen(true)}
                className="bg-[#003366] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[#002244]"
              >
                Create Subscription
              </button>
            </div>
          )}

          {subscription && (
            <>
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-base font-semibold text-gray-900">{PLAN_LABELS[subscription.plan]} Plan</h2>
                <SubStatusBadge status={subscription.subscription_status} />
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm mb-5">
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Amount</dt>
                  <dd className="text-gray-900">{formatNaira(subscription.amount_naira)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Billing Cycle</dt>
                  <dd className="text-gray-900 capitalize">{subscription.billing_cycle}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Next Billing</dt>
                  <dd className="text-gray-900">{formatDate(subscription.next_billing_date)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Trial Ends</dt>
                  <dd className="text-gray-900">{formatDate(subscription.trial_ends_at)}</dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setChangePlanOpen(true)}
                  className="border border-gray-300 rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:border-[#003366] hover:text-[#003366]"
                >
                  Change Plan
                </button>
                {subscription.subscription_status === 'trial' && (
                  <button
                    type="button"
                    onClick={() => setExtendTrialOpen(true)}
                    className="border border-gray-300 rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:border-[#003366] hover:text-[#003366]"
                  >
                    Extend Trial
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setRecordPaymentOpen(true)}
                  className="border border-gray-300 rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:border-[#003366] hover:text-[#003366]"
                >
                  Record Payment
                </button>
                <button
                  type="button"
                  onClick={handleSuspendBilling}
                  className="border border-red-200 rounded-md px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  Suspend Billing
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'users' && (
        <div className="bg-white rounded-lg shadow-sm p-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {USER_ROLES.map((role) => {
                const count = user_counts.find((u) => u.role === role)?.count ?? '0';
                return (
                  <tr key={role}>
                    <td className="py-2 pr-4 font-medium text-gray-900">{ROLE_LABELS[role]}</td>
                    <td className="py-2 pr-4 text-gray-700">{count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'activity' && (
        <div className="bg-white rounded-lg shadow-sm p-5">
          {recent_activity.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-6">No recent activity.</p>
          )}
          {recent_activity.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {recent_activity.map((entry: AuditLogEntry) => (
                <li key={entry.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <ActionBadge actionType={entry.action_type} />
                    <span className="text-sm text-gray-700 truncate">{entry.entity}</span>
                  </div>
                  <span className="text-xs text-gray-400 shrink-0">{formatRelative(entry.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {createSubOpen && (
        <CreateSubscriptionModal
          schoolId={schoolId}
          onClose={() => setCreateSubOpen(false)}
          onDone={() => {
            setCreateSubOpen(false);
            show('Subscription created', 'success');
            load();
          }}
        />
      )}

      {changePlanOpen && subscription && (
        <ChangePlanModal
          subscriptionId={subscription.id}
          currentPlan={subscription.plan}
          onClose={() => setChangePlanOpen(false)}
          onDone={() => {
            setChangePlanOpen(false);
            show('Plan updated', 'success');
            load();
          }}
        />
      )}

      {extendTrialOpen && subscription && (
        <ExtendTrialModal
          subscriptionId={subscription.id}
          onClose={() => setExtendTrialOpen(false)}
          onDone={() => {
            setExtendTrialOpen(false);
            show('Trial extended', 'success');
            load();
          }}
        />
      )}

      {recordPaymentOpen && subscription && (
        <RecordPaymentModal
          subscriptionId={subscription.id}
          onClose={() => setRecordPaymentOpen(false)}
          onDone={() => {
            setRecordPaymentOpen(false);
            show('Payment recorded', 'success');
            load();
          }}
        />
      )}
    </div>
  );
}
