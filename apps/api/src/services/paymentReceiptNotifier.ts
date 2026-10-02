import { getPaymentById } from '../db/queries/fees';
import { getParentsForStudent } from '../db/queries/parents';
import { generateReceipt } from './receiptService';
import { sendEmail } from './emailService';
import { logger } from '../config/logger';
import { appBaseUrl } from '../config/appUrls';

function formatCurrency(amount: number | string): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Generates a PDF receipt for a newly recorded payment and emails every parent linked to
 *  the student a link to view it in the Parent Portal. Never throws — a receipt failure
 *  must never affect the payment it's reporting on, which has already succeeded by the
 *  time this runs.
 *
 *  The email deliberately does NOT embed a direct storage link: email content can't be
 *  revoked or refreshed once sent, so a permanent (or even long-lived) link would be a
 *  standing exposure if the message is ever forwarded or archived. Instead it points to
 *  the authenticated Parent Portal fees page, which fetches a freshly-signed, short-lived
 *  URL from the API only when the logged-in parent clicks "Download Receipt". */
export async function notifyPaymentReceipt(schoolId: string, paymentId: string, studentId: string): Promise<void> {
  try {
    const payment = await getPaymentById(schoolId, paymentId);
    if (!payment) {
      logger.error('payment_receipt_notify_payment_not_found', { schoolId, paymentId });
      return;
    }

    // Pre-generate/cache the PDF now so it's immediately available in storage. Parents
    // never see this storage path directly — the in-app link below always mints a fresh
    // signed URL at click time.
    await generateReceipt(schoolId, payment);
    const parents = await getParentsForStudent(studentId);

    const appUrl = appBaseUrl();
    const receiptLink = `${appUrl}/parent/fees`;

    // The receipt must say what is LEFT, not only what was received.
    //
    // While an online payment was always the full balance, "we have received a payment
    // of ₦X" was harmless — it could only mean settled. The moment a parent can pay part
    // of a term's fees, that same sentence tells someone who paid a third of ₦150,000
    // that their payment was received and nothing else, which reads as paid in full.
    // Enabling partial payment turns a benign omission into a misleading one, and
    // nothing in the partial-payment change itself points here.
    const settled = Number(payment.balance) <= 0;
    const outstanding = settled
      ? 'This settles the fees for this term in full — there is no outstanding balance.'
      : `Outstanding balance: ${formatCurrency(payment.balance)} of ${formatCurrency(payment.total_amount)}.\n` +
        `You can pay the rest at any time from your Parent Portal.`;

    const subject = settled
      ? 'Payment receipt — fees settled — Chronix Edu'
      : `Payment receipt — ${formatCurrency(payment.balance)} still outstanding — Chronix Edu`;
    const body =
      `Dear Parent,\n\n` +
      `We have received a payment of ${formatCurrency(payment.amount)} for ${payment.first_name} ${payment.last_name}.\n\n` +
      `${outstanding}\n\n` +
      `Log in to your Parent Portal to view and download your receipt:\n${receiptLink}\n\n` +
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
