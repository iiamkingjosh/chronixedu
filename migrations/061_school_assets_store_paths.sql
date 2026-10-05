-- 061: school files are recorded by their path in the bucket, not by a public link (5 Oct 2026).
--
-- The school-assets bucket (logos, the school signature and stamp, staff signatures, student photos,
-- assignment files) was public: every link ever shown opened the file for anyone who had it, signed in
-- or not, and could not be withdrawn short of deleting the file. It is being made private. From this
-- release the API stores a path and makes a link that expires when a screen shows the file, or reads
-- the image itself into a PDF (services/schoolAssets.ts).
--
-- This converts the values already stored. Only Supabase public links to this bucket are rewritten, to
-- the path that follows /storage/v1/object/public/school-assets/. Anything else is left exactly as it
-- is: a value that is already a path, an empty one, or an address on some other site (the identity
-- route accepted any address until this release; the API now never fetches one, and the export lists
-- it as a reference to nothing it holds). Production held 4 files in this bucket on 5 Oct 2026.
--
-- The bucket's own switch to private is made in the Supabase dashboard after this release is live,
-- because the code that reads it this way must be running first.
--
-- Operations: UPDATE only, of the seven columns named, each limited to rows that hold a public link to
-- this bucket. Idempotent: a second run finds nothing to rewrite.

-- One pattern throughout: a Supabase public link to this bucket, with a path after it.
UPDATE school_settings
   SET identity_config = identity_config
       || jsonb_strip_nulls(jsonb_build_object(
            'logo_url', CASE WHEN identity_config->>'logo_url' ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+'
                        THEN regexp_replace(identity_config->>'logo_url', '^https?://[^/]+/storage/v1/object/public/school-assets/', '') END,
            'stamp_url', CASE WHEN identity_config->>'stamp_url' ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+'
                        THEN regexp_replace(identity_config->>'stamp_url', '^https?://[^/]+/storage/v1/object/public/school-assets/', '') END,
            'signature_url', CASE WHEN identity_config->>'signature_url' ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+'
                        THEN regexp_replace(identity_config->>'signature_url', '^https?://[^/]+/storage/v1/object/public/school-assets/', '') END))
 WHERE identity_config->>'logo_url'      ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+'
    OR identity_config->>'stamp_url'     ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+'
    OR identity_config->>'signature_url' ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+';

UPDATE users SET signature_url = regexp_replace(signature_url, '^https?://[^/]+/storage/v1/object/public/school-assets/', '') WHERE signature_url ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+';
UPDATE students SET photo_url = regexp_replace(photo_url, '^https?://[^/]+/storage/v1/object/public/school-assets/', '') WHERE photo_url ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+';
UPDATE schools SET logo_url = regexp_replace(logo_url, '^https?://[^/]+/storage/v1/object/public/school-assets/', '') WHERE logo_url ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+';
UPDATE schools SET stamp_url = regexp_replace(stamp_url, '^https?://[^/]+/storage/v1/object/public/school-assets/', '') WHERE stamp_url ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+';
UPDATE assignments SET attachment_url = regexp_replace(attachment_url, '^https?://[^/]+/storage/v1/object/public/school-assets/', '') WHERE attachment_url ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+';
UPDATE assignment_submissions SET file_url = regexp_replace(file_url, '^https?://[^/]+/storage/v1/object/public/school-assets/', '') WHERE file_url ~ '^https?://[^/]+/storage/v1/object/public/school-assets/.+';

-- End of migration 061
