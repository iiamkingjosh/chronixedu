-- bursar and registrar are valid users.role values but were omitted from the
-- announcements audience enum, so principals could never target them and
-- neither role had any way to see announcements at all.
ALTER TYPE chronixedu_announcement_target ADD VALUE IF NOT EXISTS 'bursar';
ALTER TYPE chronixedu_announcement_target ADD VALUE IF NOT EXISTS 'registrar';

-- New admin-created accounts get a temp password shown once and should be
-- required to change it on first login. Only affects future INSERTs — does
-- not retroactively flag existing accounts.
ALTER TABLE users ALTER COLUMN must_change_password SET DEFAULT TRUE;
