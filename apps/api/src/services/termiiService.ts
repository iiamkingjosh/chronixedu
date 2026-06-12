import pool from '../db/client';
import { logger } from '../config/logger';

const TERMII_URL = 'https://api.ng.termii.com/api/sms/send';

export function isSmsConfigured(): boolean {
  return !!process.env.TERMII_API_KEY;
}

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

export async function sendTermiiSms(schoolId: string, to: string, message: string): Promise<boolean> {
  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) return false;
  try {
    const from = await getSmsSenderName(schoolId);
    const res = await fetch(TERMII_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, from, sms: message, type: 'plain', channel: 'generic', api_key: apiKey }),
    });
    return res.ok;
  } catch (err) {
    logger.error('termii_sms_failed', { schoolId, error: err instanceof Error ? err.message : err });
    return false;
  }
}
