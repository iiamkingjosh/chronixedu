-- 062: an online fee payment is credited only to the school and invoice that started it (6 Oct 2026).
--
-- Until now the school and invoice an online payment was credited to came from the metadata on
-- Paystack's record of the transaction, cross-checked against a school id in the address. Nothing was
-- written on our side before Paystack was called. So a transaction created on the same Paystack account
-- some other way (Paystack's own pay widget with the public key, a payment page) could carry any school
-- and invoice in its metadata and be credited to them, while the money went wherever that transaction
-- sent it. The return page took the school from the address its caller chose. Raised by the reviewer,
-- 6 Oct 2026; SECURITY.md Round 38.
--
-- The fix is the pattern Chronix's own subscription payments already use (migration 052): when a parent
-- starts a payment, this row is written BEFORE Paystack is called, keyed by the reference Paystack will
-- report back. The return page and the webhook credit a payment only through its row: that row's school
-- and invoice, and only when Paystack verifies exactly the amount the row recorded. Paystack's metadata
-- and the address are not used. A payment with no row is not credited; it is alerted, and the bursar can
-- record it by its reference after checking it.
--
-- fee_kobo is the school fee credited to the invoice; convenience_fee_kobo is what the parent paid on top
-- for paying online (0 while the school bears Paystack's charge). Paystack is asked for their sum.
--
-- Tenant data: school_id, RLS with the service-role bypass and the school's tenant policy. Exported
-- ("Online payment attempts") and deleted with the school, before payments (payment_id references it).
--
-- Operations (doctrine 7): INSERT by the initiate route; UPDATE of status and payment_id by settlement
-- (pending -> consumed once, or -> failed); nothing else updates a row; DELETE only by the deletion script.

CREATE TABLE IF NOT EXISTS fee_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  school_id uuid NOT NULL REFERENCES schools(id),
  invoice_id uuid NOT NULL REFERENCES fee_invoices(id),
  fee_kobo bigint NOT NULL CHECK (fee_kobo > 0),
  convenience_fee_kobo bigint NOT NULL CHECK (convenience_fee_kobo >= 0),
  initiated_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'failed')),
  failure_reason text,
  payment_id uuid REFERENCES payments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_checkouts_consumed_has_payment CHECK ((status = 'consumed') = (payment_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS fee_checkouts_school ON fee_checkouts (school_id);

ALTER TABLE fee_checkouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass ON fee_checkouts;
CREATE POLICY service_role_bypass ON fee_checkouts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS fee_checkouts_tenant ON fee_checkouts;
CREATE POLICY fee_checkouts_tenant ON fee_checkouts
  FOR ALL
  USING (school_id = ((auth.jwt() ->> 'school_id'::text))::uuid)
  WITH CHECK (school_id = ((auth.jwt() ->> 'school_id'::text))::uuid);

-- End of migration 062
