-- 063: refunds of school fee payments, recorded by the school's bursar (6 Oct 2026).
--
-- Decided 5-6 Oct 2026 (Moses, on the reviewer's advice and Paystack's own pages):
--   - A refund is a record of its own. The payment it reverses is never edited, so the trail of what
--     was paid survives. The invoice's amount_paid, balance and status are recomputed from payments
--     minus refunds, in the same locked transaction a payment uses (db/queries/feeRefunds.ts), so a
--     partial refund turns "paid" back into "partly paid".
--   - Schools refund from their own money, by cash or bank transfer, for every kind of payment that moved
--     money, online payments included. A refund through Paystack's dashboard is taken from the main
--     account (Chronix's), not the school's, because the school's share has already been paid out to it.
--   - The bursar records it, with the amount, how it went back, a reason, and a reference if there is one
--     (often there is none: a parent may not note a transfer's reference). A waiver moved no money and is
--     never refunded. Refunds of one payment never exceed it, and a convenience fee is never refunded:
--     payments.amount holds only the school fee.
--   - Refunds made through Paystack, and chargebacks, will add a source and Paystack's ids here when the
--     account-wide webhook returns for the second school (branch parked/paystack-account-webhook).
--
-- Money in whole kobo (bigint), doctrine 11 for a new money column; payments.amount stays naira.
-- Tenant data: school_id, RLS with the service-role bypass and the school's tenant policy. Exported ("Fee
-- refunds") and deleted with the school, before payments (foreign key).
--
-- Operations (doctrine 7): INSERT by the bursar's route only. Nothing updates or deletes a row but the
-- deletion script; a refund recorded in error is corrected by the bursar's next record, not an edit.

CREATE TABLE IF NOT EXISTS fee_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  payment_id uuid NOT NULL REFERENCES payments(id),
  invoice_id uuid NOT NULL REFERENCES fee_invoices(id),
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  method text NOT NULL CHECK (method IN ('cash', 'bank_transfer')),
  reason text NOT NULL CHECK (reason IN ('overpaid', 'paid_twice', 'withdrew', 'wrong_child', 'other')),
  reference text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 100),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  recorded_by uuid NOT NULL REFERENCES users(id),
  refunded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- "Other" says what: a reason nobody can read later is no reason.
  CONSTRAINT fee_refunds_other_has_note CHECK (reason <> 'other' OR note IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fee_refunds_school ON fee_refunds (school_id);
CREATE INDEX IF NOT EXISTS fee_refunds_payment ON fee_refunds (payment_id);

ALTER TABLE fee_refunds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass ON fee_refunds;
CREATE POLICY service_role_bypass ON fee_refunds
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS fee_refunds_tenant ON fee_refunds;
CREATE POLICY fee_refunds_tenant ON fee_refunds
  FOR ALL
  USING (school_id = ((auth.jwt() ->> 'school_id'::text))::uuid)
  WITH CHECK (school_id = ((auth.jwt() ->> 'school_id'::text))::uuid);

-- End of migration 063
