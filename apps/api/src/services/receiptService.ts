import path from 'path';
import fs from 'fs';
import Handlebars from 'handlebars';
import { supabaseAdmin } from '../supabaseClient';
import { findSchoolById } from '../db/queries/schools';
import { getBrowser } from './reportCardService';
import type { PaymentReceiptRow } from '../db/queries/fees';

// ── Template compilation (lazy, once) ─────────────────────────────────────────

type CompiledTemplate = ReturnType<typeof Handlebars.compile>;

let compiledTemplate: CompiledTemplate | null = null;

function getTemplate(): CompiledTemplate {
  if (!compiledTemplate) {
    const tplPath = path.join(__dirname, '../templates/receipt.hbs');
    const source = fs.readFileSync(tplPath, 'utf-8');
    compiledTemplate = Handlebars.compile(source);
  }
  return compiledTemplate;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatCurrency(amount: number | string): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatMethod(method: string): string {
  return method.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Core PDF generator ─────────────────────────────────────────────────────────

export async function generateReceipt(schoolId: string, payment: PaymentReceiptRow): Promise<string> {
  const school = await findSchoolById(schoolId);
  if (!school) throw new Error(`School not found: ${schoolId}`);

  const identityConfig = (school.identity_config ?? {}) as Record<string, string | null>;

  const templateData = {
    school: {
      name: school.name,
      logoUrl: identityConfig.logo_url ?? null,
      stampUrl: identityConfig.stamp_url ?? null,
      motto: identityConfig.motto ?? null,
      address: identityConfig.address ?? null,
    },
    receiptNo: `RCT-${payment.id.slice(0, 8).toUpperCase()}`,
    paymentDate: new Date(payment.payment_date).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric',
    }),
    student: {
      fullName: `${payment.first_name} ${payment.last_name}`,
      admissionNo: payment.admission_no,
      className: payment.class_name,
    },
    term: {
      name: payment.term_name,
      sessionName: payment.session_name,
    },
    payment: {
      amount: formatCurrency(payment.amount),
      method: formatMethod(payment.method),
      reference: payment.reference ?? payment.paystack_reference ?? '—',
    },
    invoice: {
      totalAmount: formatCurrency(payment.total_amount),
      amountPaid: formatCurrency(payment.amount_paid),
      balance: formatCurrency(payment.balance),
      status: payment.invoice_status,
    },
    generatedAt: new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric',
    }),
  };

  const html = getTemplate()(templateData);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
    const pdfBuffer = await page.pdf({
      format: 'a5',
      printBackground: true,
      margin: { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' },
    });

    const storagePath = `receipts/${schoolId}/${payment.id}.pdf`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from('report-cards')
      .upload(storagePath, Buffer.from(pdfBuffer), {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('report-cards')
      .getPublicUrl(storagePath);

    return publicUrl;
  } finally {
    await page.close();
  }
}
