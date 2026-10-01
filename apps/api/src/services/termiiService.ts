import pool from '../db/client';
import { logger } from '../config/logger';

const TERMII_URL = 'https://api.ng.termii.com/api/sms/send';

/**
 * SMS is a switch, and it is OFF unless SMS_ENABLED is "true" AND TERMII_API_KEY holds a value.
 * Off since 1 Oct 2026 by decision (Termii is not funded). The keys are kept on purpose, also
 * decided 1 Oct, because SMS may come back, so the switch cannot be "is there a key?": that
 * question answers WHAT the key is, not WHETHER to send (doctrine 8), and with the keys kept it
 * would leave SMS on against a lapsed account, failing once per parent. Callers check this once
 * per run and skip SMS entirely: no provider call, no notification_logs row, one log line saying
 * so (index.ts at startup; each sending run once). Switch back on with SMS_ENABLED=true.
 */
export function isSmsEnabled(): boolean {
  return process.env.SMS_ENABLED?.trim().toLowerCase() === 'true' && !!process.env.TERMII_API_KEY?.trim();
}

/** Why SMS is off right now, for the one line each run logs. Only meaningful while it is off. */
export function smsDisabledReason(): string {
  if (process.env.SMS_ENABLED?.trim().toLowerCase() !== 'true') {
    return 'SMS_ENABLED is not "true": SMS is switched off (decided 1 Oct 2026; Termii keys kept)';
  }
  return 'SMS_ENABLED is "true" but TERMII_API_KEY is not set: SMS cannot send';
}

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
  if (!isSmsEnabled() || !apiKey) return 'disabled';
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
