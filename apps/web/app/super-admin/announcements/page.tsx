'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  publishAnnouncement,
  deleteAnnouncement,
  type Announcement,
  type AnnouncementType,
  type SchoolPlan,
  type AnnouncementStatusFilter,
} from '@/lib/superAdminApi';
import { useToast } from '@/components/Toast';

type TabKey = 'published' | 'scheduled' | 'all';

const TABS: { key: TabKey; label: string; status: AnnouncementStatusFilter }[] = [
  { key: 'published', label: 'Published', status: 'published' },
  { key: 'scheduled', label: 'Scheduled', status: 'scheduled' },
  { key: 'all', label: 'All', status: 'all' },
];

const TYPE_LABELS: Record<AnnouncementType, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
  maintenance: 'Maintenance',
};

const TYPE_BADGE: Record<AnnouncementType, string> = {
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  warning: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  critical: 'bg-red-50 text-red-700 border-red-200',
  maintenance: 'bg-gray-100 text-gray-600 border-gray-200',
};

const PLAN_LABELS: Record<SchoolPlan, string> = {
  basic: 'Basic',
  professional: 'Professional',
  enterprise: 'Enterprise',
  trial: 'Trial',
};

const ALL_PLANS: SchoolPlan[] = ['basic', 'professional', 'enterprise', 'trial'];

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Modal wrapper ─────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
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

// ── Compose / Edit modal ──────────────────────────────────────────────────────

const announcementSchema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters'),
  body: z.string().min(10, 'Body must be at least 10 characters'),
  type: z.enum(['info', 'warning', 'critical', 'maintenance']),
  target_plans: z.array(z.enum(['basic', 'professional', 'enterprise', 'trial'])).min(1, 'Select at least one plan'),
  scheduled_at: z.string().optional(),
  expires_at: z.string().optional(),
});

type AnnouncementForm = z.infer<typeof announcementSchema>;

function toDatetimeLocal(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ComposeModal({ existing, onClose, onDone }: {
  existing: Announcement | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<AnnouncementForm>({
    resolver: zodResolver(announcementSchema),
    defaultValues: existing
      ? {
          title: existing.title,
          body: existing.body,
          type: existing.type,
          target_plans: existing.target_plans,
          scheduled_at: toDatetimeLocal(existing.scheduled_at),
          expires_at: toDatetimeLocal(existing.expires_at),
        }
      : {
          title: '',
          body: '',
          type: 'info',
          target_plans: ALL_PLANS,
          scheduled_at: '',
          expires_at: '',
        },
  });
  const [apiError, setApiError] = useState('');

  async function onSubmit(values: AnnouncementForm) {
    setApiError('');
    const payload = {
      title: values.title,
      body: values.body,
      type: values.type,
      target_plans: values.target_plans,
      ...(values.scheduled_at ? { scheduled_at: new Date(values.scheduled_at).toISOString() } : {}),
      ...(values.expires_at ? { expires_at: new Date(values.expires_at).toISOString() } : {}),
    };
    try {
      if (existing) {
        await updateAnnouncement(existing.id, payload);
      } else {
        await createAnnouncement(payload);
      }
      onDone();
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : 'Failed to save announcement');
    }
  }

  return (
    <Modal title={existing ? 'Edit Announcement' : 'New Announcement'} onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Field label="Title" error={errors.title?.message}>
          <input {...register('title')} className={inputClass} placeholder="Scheduled maintenance this weekend" />
        </Field>
        <Field label="Body" error={errors.body?.message}>
          <textarea {...register('body')} rows={4} className={inputClass} placeholder="Write the announcement message..." />
        </Field>
        <Field label="Type" error={errors.type?.message}>
          <select {...register('type')} className={inputClass}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </Field>
        <Field label="Target Plans" error={errors.target_plans?.message}>
          <div className="flex flex-wrap gap-3">
            {ALL_PLANS.map((plan) => (
              <label key={plan} className="flex items-center gap-2 text-sm text-gray-700">
                <input {...register('target_plans')} type="checkbox" value={plan} className="accent-slate-700" />
                {PLAN_LABELS[plan]}
              </label>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Scheduled At (optional)" error={errors.scheduled_at?.message}>
            <input {...register('scheduled_at')} type="datetime-local" className={inputClass} />
          </Field>
          <Field label="Expires At (optional)" error={errors.expires_at?.message}>
            <input {...register('expires_at')} type="datetime-local" className={inputClass} />
          </Field>
        </div>
        {apiError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
            <p className="text-sm text-red-700">{apiError}</p>
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-5 py-2 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002244] disabled:opacity-50 transition-colors">
            {isSubmitting ? 'Saving…' : existing ? 'Save Changes' : 'Create Announcement'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SuperAdminAnnouncementsPage() {
  const { show } = useToast();

  const [tab, setTab] = useState<TabKey>('published');
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeStatus = TABS.find((t) => t.key === tab)?.status ?? 'all';

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getAnnouncements(activeStatus)
      .then(setAnnouncements)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [activeStatus]);

  useEffect(() => { load(); }, [load]);

  async function handlePublish(announcement: Announcement) {
    if (!window.confirm(`Publish "${announcement.title}" now? This will email all matching principals.`)) return;
    setBusyId(announcement.id);
    try {
      const res = await publishAnnouncement(announcement.id);
      show(`Announcement sent to ${res.recipients_count} principals`, 'success');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to publish announcement', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(announcement: Announcement) {
    if (!window.confirm(`Delete "${announcement.title}"? This cannot be undone.`)) return;
    setBusyId(announcement.id);
    try {
      await deleteAnnouncement(announcement.id);
      show('Announcement deleted', 'success');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to delete announcement', 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 font-heading">Announcements</h1>
        <button
          type="button"
          onClick={() => setComposeOpen(true)}
          className="bg-[#003366] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[#002244]"
        >
          New Announcement
        </button>
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

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading && <p className="text-sm text-gray-400">Loading…</p>}

      {!loading && announcements.length === 0 && (
        <p className="text-sm text-gray-400">No announcements found.</p>
      )}

      <div className="space-y-3">
        {!loading && announcements.map((a) => {
          const isPublished = !!a.published_at;
          return (
            <div key={a.id} className="bg-white rounded-lg shadow-sm p-5">
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="text-sm font-bold text-gray-900 truncate">{a.title}</h3>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${TYPE_BADGE[a.type]}`}>
                    {TYPE_LABELS[a.type]}
                  </span>
                </div>
                {isPublished ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-green-50 text-green-700 border-green-200 shrink-0">
                    Published
                  </span>
                ) : (
                  <div className="flex items-center gap-3 shrink-0 text-sm">
                    <button onClick={() => setEditing(a)} disabled={busyId === a.id} className="text-slate-600 hover:text-slate-900 font-medium disabled:opacity-50">Edit</button>
                    <button onClick={() => handlePublish(a)} disabled={busyId === a.id} className="text-green-600 hover:text-green-700 font-medium disabled:opacity-50">Publish Now</button>
                    <button onClick={() => handleDelete(a)} disabled={busyId === a.id} className="text-red-600 hover:text-red-700 font-medium disabled:opacity-50">Delete</button>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-1 mb-2">
                {a.target_plans.map((plan) => (
                  <span key={plan} className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
                    {PLAN_LABELS[plan]}
                  </span>
                ))}
              </div>
              <p className="text-sm text-gray-600 line-clamp-2 mb-2">{a.body}</p>
              <p className="text-xs text-gray-400">
                {isPublished ? `Published ${formatDateTime(a.published_at)}` : a.scheduled_at ? `Scheduled for ${formatDateTime(a.scheduled_at)}` : 'Not scheduled'}
              </p>
            </div>
          );
        })}
      </div>

      {composeOpen && (
        <ComposeModal
          existing={null}
          onClose={() => setComposeOpen(false)}
          onDone={() => {
            setComposeOpen(false);
            show('Announcement created', 'success');
            load();
          }}
        />
      )}

      {editing && (
        <ComposeModal
          existing={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            show('Announcement updated', 'success');
            load();
          }}
        />
      )}
    </div>
  );
}
