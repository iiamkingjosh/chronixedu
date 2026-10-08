import pool from '../db/client';
import defaults from '../config/notificationDefaults.json';

/**
 * Settings → Notifications, read (audit, 8 Oct 2026; Moses: "Make it work"). The page saved a school's
 * choices to `school_settings.notification_config` and nothing read them: every event went by every
 * channel, and attendance alerts fired at a fixed 3 absences in 7 days, whatever the school had set.
 *
 * The defaults apply where a school has chosen nothing, and the page shows them as the defaults. They
 * live in config/notificationDefaults.json, which apps/web/lib keeps an identical copy of
 * (notificationDefaults.test.ts).
 */

export type NotificationEvent = keyof typeof defaults.events;
export interface Channels { in_app: boolean; email: boolean; sms: boolean }

export const NOTIFICATION_EVENTS = Object.keys(defaults.events) as NotificationEvent[];
export const DEFAULT_ATTENDANCE_ALERT: { threshold: number; window_days: number } = defaults.attendance_alert;

/** The channels a school has chosen for one event, each falling back to the default when unset. */
export function channelsFor(config: Record<string, unknown> | null | undefined, event: NotificationEvent): Channels {
  const base = defaults.events[event];
  const chosen = ((config?.events ?? {}) as Record<string, Record<string, unknown> | undefined>)[event] ?? {};
  const pick = (k: keyof Channels) => (typeof chosen[k] === 'boolean' ? (chosen[k] as boolean) : base[k]);
  return { in_app: pick('in_app'), email: pick('email'), sms: pick('sms') };
}

/** The school's low-attendance rule: this many absences within this many days, inclusive. */
export function attendanceAlertRule(config: Record<string, unknown> | null | undefined): { threshold: number; window_days: number } {
  const chosen = (config?.attendance_alert ?? {}) as Record<string, unknown>;
  const whole = (v: unknown, min: number, max: number) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : null);
  return {
    threshold: whole(chosen.threshold, 1, 30) ?? DEFAULT_ATTENDANCE_ALERT.threshold,
    window_days: whole(chosen.window_days, 1, 60) ?? DEFAULT_ATTENDANCE_ALERT.window_days,
  };
}

/** A school's saved notification settings; an empty object when it has none. */
export async function loadNotificationConfig(schoolId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{ notification_config: Record<string, unknown> | null }>(
    `SELECT notification_config FROM school_settings WHERE school_id = $1`, [schoolId]);
  return rows[0]?.notification_config ?? {};
}
