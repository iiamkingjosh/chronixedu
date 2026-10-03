-- 054: platform_pricing_config.updated_at moves on every change, whoever makes it (3 Oct 2026).
--
-- The Subscriptions panel says the rate was "changed outside Chronix Edu" when the stored rate is
-- newer than, or differs from, the last PRICING_RATE_SET audit row (routes/superAdmin.ts,
-- GET /pricing). That comparison holds only if updated_at moves on every write. An INSERT stamps it
-- through the column default, but a hand UPDATE that sets only price_per_student_kobo would leave
-- it where it was, and the change would go unseen.
--
-- Found on the day the rate was first set: ₦800 was entered by hand in the Supabase SQL editor
-- before the screen's first save, so that save's audit row correctly records previous_kobo 80000,
-- and nothing records the hand entry itself (docs/AUDIT-2026-09.md).
--
-- Operations, each checked on its own (doctrine 7):
--   UPDATE: updated_at := now(), whatever the statement set (tested). The route's own save is an
--           upsert in one transaction, so its updated_at still equals its audit row's created_at.
--   INSERT: unaffected; the column default already stamps it.
--   DELETE: leaves no row; the panel reports that from the audit side (tested).
--
-- LOAD-BEARING: now() is the TRANSACTION's start time, so the route's save (config upsert, this
-- trigger, and the audit row's created_at default) all carry one identical timestamp, and the
-- panel's "newer than the last save" comparison sees no difference. Switch any of them to
-- clock_timestamp() and they stop matching: the panel would warn on every normal save.
--
-- A trigger function cannot be called on its own, so Supabase's /rest/v1/rpc cannot reach it.
-- EXECUTE is revoked from PUBLIC anyway, as for every function in public.

CREATE OR REPLACE FUNCTION platform_pricing_config_touch() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform_pricing_config_touch() FROM PUBLIC;

DROP TRIGGER IF EXISTS platform_pricing_config_touch ON platform_pricing_config;
CREATE TRIGGER platform_pricing_config_touch
  BEFORE UPDATE ON platform_pricing_config
  FOR EACH ROW EXECUTE FUNCTION platform_pricing_config_touch();
