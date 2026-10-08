-- 064: the school's address lives in one place, identity_config.address (audit, 8 Oct 2026).
--
-- Receipts and report cards print school_settings.identity_config->>'address'. Onboarding wrote the
-- address to schools.address, which nothing reads, and Settings -> School Identity's Address field was
-- dropped by the route. So no school's address has ever reached a document. From now on onboarding and
-- the settings page both write identity_config.address; this copies across each address already typed
-- at onboarding, where the school has a settings row and no address there yet.
--
-- Data only: no table, column, policy or grant changes. Idempotent: a second run finds nothing to copy.

UPDATE school_settings ss
   SET identity_config = COALESCE(ss.identity_config, '{}'::jsonb) || jsonb_build_object('address', btrim(s.address))
  FROM schools s
 WHERE s.id = ss.school_id
   AND s.address IS NOT NULL
   AND btrim(s.address) <> ''
   AND NULLIF(btrim(COALESCE(ss.identity_config->>'address', '')), '') IS NULL;
