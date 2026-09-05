ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS event_date date;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'collections'
      AND column_name = 'event_at'
  ) THEN
    UPDATE collections
      SET event_date = (event_at AT TIME ZONE 'UTC')::date
      WHERE event_date IS NULL AND event_at IS NOT NULL;
    ALTER TABLE collections DROP COLUMN event_at;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS collections_vault_event_date_idx
  ON collections (vault_id, event_date DESC, id DESC)
  WHERE archived_at IS NULL AND event_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS photos_vault_captured_idx
  ON photos (vault_id, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS photos_vault_uploaded_idx
  ON photos (vault_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS photos_vault_filename_idx
  ON photos (vault_id, (LOWER(original_filename) COLLATE "C"), id);

-- Down migration:
-- DROP INDEX collections_vault_event_date_idx;
-- DROP INDEX photos_vault_captured_idx;
-- DROP INDEX photos_vault_uploaded_idx;
-- DROP INDEX photos_vault_filename_idx;
-- ALTER TABLE collections DROP COLUMN event_date;
