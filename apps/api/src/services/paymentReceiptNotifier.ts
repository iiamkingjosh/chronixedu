import { getPaymentById } from '../db/queries/fees';
import { getParentsForStudent } from '../db/queries/parents';
import { generateReceipt } from './receiptService';
import { sendEmail } from './emailService';
import { logger } from '../config/logger';

function formatCurrency(amount: number | string): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Generates a PDF receipt for a newly recorded payment and emails a link to every
 *  parent linked to the student. Never throws — a receipt failure must never affect
 *  the payment it's reporting on, which has already succeeded by the time this runs. */
export async function notifyPaymentReceipt(schoolId: string, paymentId: string, studentId: string): Promise<void> {
  try {
    const payment = await getPaymentById(schoolId, paymentId);
    if (!payment) {
      logger.error('payment_receipt_notify_payment_not_found', { schoolId, paymentId });
      return;
    }

    const url = await generateReceipt(schoolId, payment);
    const parents = await getParentsForStudent(studentId);

    const subject = 'Payment receipt — Chronix Edu';
    const body =
      `Dear Parent,\n\n` +
      `We have received a payment of ${formatCurrency(payment.amount)} for ${payment.first_name} ${payment.last_name}.\n\n` +
      `You can view and download your receipt here:\n${url}\n\n` +
      `Thank you,\nChronix Edu`;

    for (const parent of parents) {
      try {
        await sendEmail(parent.email, subject, body);
      } catch (err) {
        logger.error('payment_receipt_notify_email_failed', {
          schoolId,
          paymentId,
          studentId,
          parentId: parent.parent_id,
          error: err instanceof Error ? err.message : err,
        });
      }
    }
  } catch (err) {
    logger.error('payment_receipt_notify_failed', {
      schoolId,
      paymentId,
      studentId,
      error: err instanceof Error ? err.message : err,
    });
  }
}
