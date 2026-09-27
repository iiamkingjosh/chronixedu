-- 040: per-school fee policy, for the parent-facing part-payment minimum.
--
-- Parents can pay part of a term's fees online. `bearer: 'subaccount'` is set on the
-- Paystack initiate call, so the school — not the parent — pays the transaction fee on
-- every attempt. Twenty ₦500 payments against a ₦10,000 balance costs the school more in
-- fees than one payment would, so an unbounded floor is a margin leak that looks like a
-- feature.
--
-- Stored in kobo, like every money value the API computes with (doctrine 7). Flat, not a
-- percentage: partial payment exists for the parent who cannot pay the whole amount, and
-- a percentage floor scales the barrier with the fee — 10% of a ₦500,000 secondary term
-- is ₦50,000, which is precisely the parent the feature is for and precisely the one it
-- would turn away.
--
-- A default of ₦1,000 is defensible where `promotion_cutoff ?? 40` was not, and the
-- distinction is worth stating: that default made a claim about the SCHOOL'S policy, on a
-- report card a parent keeps, silently. This is a guardrail on transaction cost, and the
-- settings UI names it as ours — "Chronix default, change this to your school's figure".
-- A disclosed default is a different object from an invented one.
--
-- Its own column rather than a key inside academic_config, because fees are not academic
-- policy and because academic_config carries `level_overrides`, which this has no business
-- inheriting.

ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS fee_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN school_settings.fee_config IS
  'Per-school fee policy. min_part_payment_kobo: the smallest part payment a parent may make online; a payment that CLEARS the balance is always allowed regardless. Kobo, integer.';
