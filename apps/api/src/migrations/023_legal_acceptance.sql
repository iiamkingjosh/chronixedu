-- Legal acceptance: record when a school accepts the ToS, Privacy Policy, DPA and AUP during onboarding
ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS legal_terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS legal_terms_accepted_ip TEXT;
