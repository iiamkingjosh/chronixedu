import pool from '../client';
import { toKobo, fromKobo } from '../../services/money';
import { deriveStatus, type FeeInvoiceRow } from './fees';

/**
 * Refunds of school fee payments (migration 063), recorded by the bursar. A refund is a record of its
 * own; the payment it reverses is never edited. The invoice is recomputed in the same transaction, under
 * the same invoice lock recordPayment takes, so a refund and a payment on one invoice cannot race.
 */

export const REFUND_REASONS = ['overpaid', 'paid_twice', 'withdrew', 'wrong_child', 'other'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export interface FeeRefundRow {
  id: string;
  school_id: string;
  payment_id: string;
  invoice_id: string;
  amount_kobo: string;
  method: 'cash' | 'bank_transfer';
  reason: RefundReason;
  reference: string | null;
  note: string | null;
  recorded_by: string;
  refunded_at: string;
  created_at: string;
}

export interface RefundInput {
  amountKobo: number;
  method: 'cash' | 'bank_transfer';
  reason: RefundReason;
  reference: string | null;
  note: string | null;
  recordedBy: string;
}

export type RefundOutcome =
  | { outcome: 'recorded'; refund: FeeRefundRow; invoice: FeeInvoiceRow }
  | { outcome: 'not_found' }
  | { outcome: 'waiver' }
  | { outcome: 'exceeds_payment'; refundableKobo: number };

/**
 * Records one refund against one payment and recomputes its invoice, in one transaction:
 *  - the invoice row is locked first, as recordPayment locks it;
 *  - a waiver is never refunded: it moved no money;
 *  - the payment's refunds can never add up to more than the payment, which holds the school fee only,
 *    so a convenience fee is never refunded;
 *  - amount_paid falls by the refund, and balance and status follow.
 * `paymentId` must belong to `schoolId`; otherwise nothing is written ('not_found').
 */
export async function recordRefund(schoolId: string, paymentId: string, input: RefundInput): Promise<RefundOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payment = (await client.query<{ invoice_id: string; amount: string; method: string }>(
      `SELECT invoice_id, amount, method FROM payments WHERE id = $1 AND school_id = $2`,
      [paymentId, schoolId]
    )).rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return { outcome: 'not_found' };
    }
    if (payment.method === 'waiver') {
      await client.query('ROLLBACK');
      return { outcome: 'waiver' };
    }

    const invoice = (await client.query<{ total_amount: string; amount_paid: string }>(
      `SELECT total_amount, amount_paid FROM fee_invoices WHERE id = $1 AND school_id = $2 FOR UPDATE`,
      [payment.invoice_id, schoolId]
    )).rows[0];
    if (!invoice) {
      await client.query('ROLLBACK');
      return { outcome: 'not_found' };
    }

    const alreadyRefundedKobo = Number((await client.query<{ kobo: string }>(
      `SELECT coalesce(sum(amount_kobo), 0) AS kobo FROM fee_refunds WHERE payment_id = $1`,
      [paymentId]
    )).rows[0].kobo);
    const refundableKobo = toKobo(payment.amount) - alreadyRefundedKobo;
    if (input.amountKobo > refundableKobo) {
      await client.query('ROLLBACK');
      return { outcome: 'exceeds_payment', refundableKobo };
    }

    const refund = (await client.query<FeeRefundRow>(
      `INSERT INTO fee_refunds (school_id, payment_id, invoice_id, amount_kobo, method, reason, reference, note, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [schoolId, paymentId, payment.invoice_id, input.amountKobo, input.method, input.reason, input.reference, input.note, input.recordedBy]
    )).rows[0];

    const totalKobo = toKobo(invoice.total_amount);
    const paidKobo = toKobo(invoice.amount_paid) - input.amountKobo;
    const updated = (await client.query<FeeInvoiceRow>(
      `UPDATE fee_invoices
          SET amount_paid = $1, balance = $2, status = $3, updated_at = NOW()
        WHERE id = $4
        RETURNING id, school_id, student_id, term_id, total_amount, amount_paid, balance, status, created_at, updated_at`,
      [fromKobo(paidKobo), fromKobo(totalKobo - paidKobo), deriveStatus(totalKobo, paidKobo), payment.invoice_id]
    )).rows[0];

    await client.query('COMMIT');
    return { outcome: 'recorded', refund, invoice: updated };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
