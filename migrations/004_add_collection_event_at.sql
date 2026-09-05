ALTER TABLE collections
  ADD COLUMN event_at timestamptz;

CREATE INDEX collections_vault_event_idx
  ON collections (vault_id, event_at DESC, id DESC)
  WHERE archived_at IS NULL AND event_at IS NOT NULL;

CREATE INDEX photos_vault_captured_idx
  ON photos (vault_id, captured_at DESC, id DESC);

CREATE INDEX photos_vault_uploaded_idx
  ON photos (vault_id, created_at DESC, id DESC);

-- Down migration:
-- DROP INDEX collections_vault_event_idx;
-- DROP INDEX photos_vault_captured_idx;
-- DROP INDEX photos_vault_uploaded_idx;
-- ALTER TABLE collections DROP COLUMN event_at;
