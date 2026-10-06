import pool from '../client';
import { recordPayment, type PaymentRow, type FeeInvoiceRow } from './fees';
import { PAYMENT_CURRENCY } from '../../services/paystackService';

/**
 * An online fee payment is credited only through the record its own start wrote (migration 062): that
 * record's school and invoice, at exactly the amount it asked Paystack for. Paystack's metadata, and the
 * school in the address a webhook or the return page arrived at, are never used to decide either. The
 * same pattern as Chronix's own subscription payments (db/queries/platformBilling.ts).
 */

export interface FeeCheckoutRow {
  id: string;
  reference: string;
  school_id: string;
  invoice_id: string;
  fee_kobo: string;
  convenience_fee_kobo: string;
  initiated_by: string;
  status: 'pending' | 'consumed' | 'failed';
  failure_reason: string | null;
  payment_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Written before Paystack is called: the reference Paystack will report, and what it is for. */
export async function createFeeCheckout(input: {
  reference: string; schoolId: string; invoiceId: string; feeKobo: number; convenienceFeeKobo: number; initiatedBy: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO fee_checkouts (reference, school_id, invoice_id, fee_kobo, convenience_fee_kobo, initiated_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.reference, input.schoolId, input.invoiceId, input.feeKobo, input.convenienceFeeKobo, input.initiatedBy]
  );
}

/** A start that went nowhere (Paystack refused to open the payment), or a payment refused at settlement. */
export async function markFeeCheckoutFailed(reference: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE fee_checkouts SET status = 'failed', failure_reason = $2, updated_at = now() WHERE reference = $1 AND status = 'pending'`,
    [reference, reason]
  );
}

export type FeeSettlement =
  | { outcome: 'credited'; payment: PaymentRow; invoice: FeeInvoiceRow; schoolId: string; recordedBy: string }
  | { outcome: 'duplicate'; schoolId: string }
  | { outcome: 'no_checkout' }
  | { outcome: 'not_naira'; schoolId: string }
  | { outcome: 'amount_mismatch'; schoolId: string; expectedKobo: number; verifiedKobo: number }
  | { outcome: 'invoice_missing'; schoolId: string };

/**
 * Credits a verified Paystack payment through its record. The caller has verified it with Paystack
 * (status success); this decides where it goes and whether the amount is the one that was started.
 * Idempotent: a payment already credited is a duplicate, whichever delivery (webhook or return page)
 * arrives first, and payments.paystack_reference is UNIQUE behind it.
 */
export async function settleFeeCheckout(reference: string, verifiedKobo: number, verifiedCurrency: string): Promise<FeeSettlement> {
  const checkout = (await pool.query<FeeCheckoutRow>(`SELECT * FROM fee_checkouts WHERE reference = $1`, [reference])).rows[0];
  if (!checkout) return { outcome: 'no_checkout' };
  if (checkout.status === 'consumed') return { outcome: 'duplicate', schoolId: checkout.school_id };

  if (verifiedCurrency !== PAYMENT_CURRENCY) {
    await markFeeCheckoutFailed(reference, 'not_naira');
    return { outcome: 'not_naira', schoolId: checkout.school_id };
  }
  const expectedKobo = Number(checkout.fee_kobo) + Number(checkout.convenience_fee_kobo);
  if (verifiedKobo !== expectedKobo) {
    await markFeeCheckoutFailed(reference, 'amount_mismatch');
    return { outcome: 'amount_mismatch', schoolId: checkout.school_id, expectedKobo, verifiedKobo };
  }

  let result;
  try {
    // The invoice is credited with the school fee only. A convenience fee went to Paystack, not the school.
    result = await recordPayment(checkout.school_id, checkout.invoice_id, {
      amountKobo: Number(checkout.fee_kobo),
      method: 'paystack',
      reference: null,
      paystack_reference: reference,
      recorded_by: checkout.initiated_by,
    });
  } catch (err) {
    // Two deliveries of one payment at the same moment: the second hits payments' UNIQUE reference.
    if ((err as { code?: string }).code === '23505') return { outcome: 'duplicate', schoolId: checkout.school_id };
    throw err;
  }
  if (!result) {
    await markFeeCheckoutFailed(reference, 'invoice_missing');
    return { outcome: 'invoice_missing', schoolId: checkout.school_id };
  }

  await pool.query(
    `UPDATE fee_checkouts SET status = 'consumed', payment_id = $2, failure_reason = NULL, updated_at = now()
      WHERE reference = $1 AND status <> 'consumed'`,
    [reference, result.payment.id]
  );
  if (result.duplicate) return { outcome: 'duplicate', schoolId: checkout.school_id };
  return { outcome: 'credited', payment: result.payment, invoice: result.invoice, schoolId: checkout.school_id, recordedBy: checkout.initiated_by };
}
