import pool from '../db/client';
import { logger } from '../config/logger';

const TERMII_URL = 'https://api.ng.termii.com/api/sms/send';

/**
 * SMS is a switch, and it is OFF unless TERMII_API_KEY holds a value (unset or blank: off).
 * Off since 1 Oct 2026 by decision — Termii is not funded — so an unset key is the intended
 * state, not a broken integration. Same rule as ERP_INTEGRATION_API_KEY: a missing secret
 * means the feature is off, stated once, never a failure per message. Callers check this
 * once per run and skip SMS entirely: no provider call, no notification_logs row, one log
 * line saying so (index.ts at startup; each sending run once). The code stays so Termii, or a
 * replacement, can be switched back on by setting the key.
 */
export function isSmsEnabled(): boolean {
  return !!process.env.TERMII_API_KEY?.trim();
}

/** The one reason every "SMS is off" log line gives, so they read and grep alike. */
export const SMS_DISABLED_REASON = 'TERMII_API_KEY is not set: SMS is switched off (decided 1 Oct 2026)';

/** What became of one message. 'disabled' is not a failure: SMS is switched off. */
export type SmsOutcome = 'sent' | 'failed' | 'disabled';

async function getSmsSenderName(schoolId: string): Promise<string> {
  const result = await pool.query<{ notification_config: Record<string, unknown> | null }>(
    `SELECT notification_config FROM school_settings WHERE school_id = $1`,
    [schoolId]
  );
  const senderName = result.rows[0]?.notification_config?.sms_sender_name;
  if (typeof senderName === 'string' && senderName.trim()) {
    return senderName.trim();
  }
  return process.env.TERMII_SENDER_ID || 'ChronixEdu';
}

export async function sendTermiiSms(schoolId: string, to: string, message: string): Promise<SmsOutcome> {
  const apiKey = process.env.TERMII_API_KEY?.trim();
  if (!apiKey) return 'disabled';
  try {
    const from = await getSmsSenderName(schoolId);
    const res = await fetch(TERMII_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, from, sms: message, type: 'plain', channel: 'generic', api_key: apiKey }),
    });
    if (res.ok) return 'sent';
    // A rejection was returned as false and logged nowhere. The number is not logged.
    logger.error('termii_sms_failed', { schoolId, status: res.status });
    return 'failed';
  } catch (err) {
    logger.error('termii_sms_failed', { schoolId, error: err instanceof Error ? err.message : err });
    return 'failed';
  }
}
