-- 003_rules.sql: reply rules gain an explicit persona, a human escalation mailbox and an
-- updated_at stamp; media rows record their kind so listings and playlists can filter without
-- re-deriving it from the mime type. Additive only: existing rows keep working.
ALTER TABLE ai_rules ADD COLUMN persona TEXT;
ALTER TABLE ai_rules ADD COLUMN escalation_email TEXT;
ALTER TABLE ai_rules ADD COLUMN updated_at TEXT;
ALTER TABLE media ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
UPDATE media SET kind = CASE
  WHEN mime LIKE 'video/%' THEN 'video'
  WHEN mime LIKE 'image/%' THEN 'image'
  ELSE 'file'
END;
