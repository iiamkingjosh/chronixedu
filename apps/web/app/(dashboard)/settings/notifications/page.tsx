'use client';

import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Schema ────────────────────────────────────────────────────────────────────

const channelsSchema = z.object({
  in_app: z.boolean(),
  email: z.boolean(),
  sms: z.boolean(),
});

const formSchema = z.object({
  sms_sender_name: z.string().max(11, 'Must be 11 characters or fewer'),
  attendance_alert_threshold: z.coerce.number().int().min(1, 'Must be at least 1').max(30, 'Must be 30 or less'),
  attendance_alert_window_days: z.coerce.number().int().min(1, 'Must be at least 1').max(60, 'Must be 60 or less'),
  events: z.record(z.string(), channelsSchema),
});

type FormValues = z.output<typeof formSchema>;
type FormValuesInput = z.input<typeof formSchema>;
type Channels = z.output<typeof channelsSchema>;

interface NotificationConfig {
  sms_sender_name?: string;
  attendance_alert?: { threshold?: number; window_days?: number };
  events?: Record<string, Partial<Channels>>;
}

// ── Event types ───────────────────────────────────────────────────────────────

const EVENT_TYPES: { key: string; label: string; description: string }[] = [
  { key: 'low_attendance', label: 'Attendance Alert', description: 'A student has crossed the absence threshold' },
  { key: 'behaviour_incident', label: 'Behaviour Incident', description: 'A behaviour incident is recorded for a student' },
  { key: 'results_published', label: 'Result Published', description: 'A term result has been published' },
  { key: 'results_returned', label: 'Result Returned', description: 'A submitted result has been returned for correction' },
  { key: 'announcement', label: 'Announcement', description: 'A school-wide announcement is posted' },
  { key: 'message', label: 'New Message', description: 'A new direct message is received' },
];

const DEFAULT_EVENT_CHANNELS: Record<string, Channels> = {
  low_attendance:     { in_app: true, email: true,  sms: false },
  behaviour_incident: { in_app: true, email: true,  sms: false },
  results_published:  { in_app: true, email: true,  sms: false },
  results_returned:   { in_app: true, email: false, sms: false },
  announcement:       { in_app: true, email: true,  sms: false },
  message:            { in_app: true, email: false, sms: false },
};

const DEFAULT_VALUES: FormValuesInput = {
  sms_sender_name: '',
  attendance_alert_threshold: 3,
  attendance_alert_window_days: 7,
  events: DEFAULT_EVENT_CHANNELS,
};

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

export default function NotificationSettingsPage() {
  const { schoolId, user } = useAuth();
  const { toast, show } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);

  const {
    control,
    handleSubmit,
    reset,
  } = useForm<FormValuesInput, unknown, FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: DEFAULT_VALUES,
  });

  // Load existing settings
  useEffect(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: { notification_config?: NotificationConfig } }>(
      `/api/schools/${schoolId}`
    )
      .then(({ data }) => {
        const nc = data.notification_config ?? {};
        const mergedEvents: Record<string, Channels> = {};
        for (const { key } of EVENT_TYPES) {
          mergedEvents[key] = { ...DEFAULT_EVENT_CHANNELS[key], ...(nc.events?.[key] ?? {}) };
        }
        reset({
          sms_sender_name: nc.sms_sender_name ?? '',
          attendance_alert_threshold: nc.attendance_alert?.threshold ?? 3,
          attendance_alert_window_days: nc.attendance_alert?.window_days ?? 7,
          events: mergedEvents,
        });
      })
      .catch(() => show('Failed to load notification settings', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  async function onSubmit(values: FormValues) {
    if (!schoolId) return;
    setSaving(true);
    try {
      const senderName = values.sms_sender_name.trim();
      await apiFetch(`/api/schools/${schoolId}/notification-config`, {
        method: 'PATCH',
        body: JSON.stringify({
          attendance_alert_threshold: values.attendance_alert_threshold,
          attendance_alert_window_days: values.attendance_alert_window_days,
          events: values.events,
          ...(senderName ? { sms_sender_name: senderName } : {}),
        }),
      });
      show('Notification settings saved');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function sendTestEmail() {
    if (!schoolId) return;
    setSendingTest(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { message: string } }>(
        `/api/schools/${schoolId}/notifications/test-email`,
        { method: 'POST' }
      );
      show(res.data.message);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to send test email', 'error');
    } finally {
      setSendingTest(false);
    }
  }

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

      <h1 className="text-xl font-semibold text-gray-900 mb-1">Notification Settings</h1>
      <p className="text-sm text-gray-500 mb-8">Control how staff and parents are notified about school events</p>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">

        {/* Email test */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Email Delivery</h2>
          <p className="text-sm text-gray-500">
            Send a test email to <span className="font-medium text-gray-700">{user?.email ?? 'your account email'}</span> to confirm SendGrid is configured correctly.
          </p>
          <button
            type="button"
            onClick={sendTestEmail}
            disabled={sendingTest}
            className="px-4 py-2 bg-white border border-gray-300 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {sendingTest ? 'Sending…' : 'Send Test Email'}
          </button>
        </section>

        {/* SMS sender name */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">SMS Sender Name</h2>
          <p className="text-sm text-gray-500">The sender ID shown to parents on SMS notifications (max 11 characters).</p>
          <Controller
            control={control}
            name="sms_sender_name"
            render={({ field: f, fieldState }) => (
              <div>
                <input
                  {...f}
                  maxLength={11}
                  className="w-full max-w-xs border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                  placeholder="ChronixEdu"
                />
                {fieldState.error && <p className="text-xs text-red-600 mt-1.5">{fieldState.error.message}</p>}
              </div>
            )}
          />
        </section>

        {/* Attendance alert threshold */}
        <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Attendance Alerts</h2>
          <p className="text-sm text-gray-500">Notify parents when a student&apos;s absences reach this threshold within the given period.</p>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-gray-700">Alert after</span>
            <Controller
              control={control}
              name="attendance_alert_threshold"
              render={({ field: f, fieldState }) => (
                <div>
                  <input
                    {...f}
                    value={f.value as number}
                    type="number"
                    min={1}
                    max={30}
                    className="w-20 border border-gray-300 rounded-md px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-slate-400"
                  />
                  {fieldState.error && <p className="text-xs text-red-600 mt-0.5">{fieldState.error.message}</p>}
                </div>
              )}
            />
            <span className="text-sm text-gray-700">absences in</span>
            <Controller
              control={control}
              name="attendance_alert_window_days"
              render={({ field: f, fieldState }) => (
                <div>
                  <input
                    {...f}
                    value={f.value as number}
                    type="number"
                    min={1}
                    max={60}
                    className="w-20 border border-gray-300 rounded-md px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-slate-400"
                  />
                  {fieldState.error && <p className="text-xs text-red-600 mt-0.5">{fieldState.error.message}</p>}
                </div>
              )}
            />
            <span className="text-sm text-gray-700">days</span>
          </div>
        </section>

        {/* Event toggle table */}
        <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-6 pb-0">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Notification Events</h2>
            <p className="text-sm text-gray-500 mt-1 mb-4">Choose which channels are used for each event type.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-gray-200 text-xs font-medium uppercase tracking-wide text-gray-400 bg-gray-50">
                  <th className="px-6 py-3 text-left">Event</th>
                  <th className="px-3 py-3 text-center">In-App</th>
                  <th className="px-3 py-3 text-center">Email</th>
                  <th className="px-3 py-3 text-center">SMS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {EVENT_TYPES.map(({ key, label, description }) => (
                  <tr key={key}>
                    <td className="px-6 py-3">
                      <p className="font-medium text-gray-900">{label}</p>
                      <p className="text-xs text-gray-400">{description}</p>
                    </td>
                    {(['in_app', 'email', 'sms'] as const).map(channel => (
                      <td key={channel} className="px-3 py-3 text-center">
                        <Controller
                          control={control}
                          name={`events.${key}.${channel}`}
                          render={({ field: f }) => (
                            <input
                              type="checkbox"
                              checked={f.value as boolean}
                              onChange={e => f.onChange(e.target.checked)}
                              disabled={channel === 'sms'}
                              title={channel === 'sms' ? 'SMS notifications activate in Phase 3' : undefined}
                              className="h-4 w-4 rounded border-gray-300 accent-slate-700 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                            />
                          )}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-3 border-t border-gray-100">
            <p className="text-xs text-gray-400">SMS notifications are not yet available — this column activates in Phase 3.</p>
          </div>
        </section>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
