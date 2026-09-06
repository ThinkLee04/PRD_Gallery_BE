ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS cover_photo_id uuid REFERENCES photos (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS collections_cover_photo_idx
  ON collections (cover_photo_id)
  WHERE cover_photo_id IS NOT NULL;

-- Down migration:
-- DROP INDEX collections_cover_photo_idx;
-- ALTER TABLE collections DROP COLUMN cover_photo_id;
