-- Singleton vault, access approval, collections, media, and private favorites.

ALTER TABLE users
  ADD COLUMN approval_status text NOT NULL DEFAULT 'PENDING'
    CHECK (approval_status IN ('PENDING', 'APPROVED')),
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approved_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN is_app_admin boolean NOT NULL DEFAULT false;

CREATE INDEX users_approval_queue_idx
  ON users (approval_status, created_at, id);

CREATE TABLE vaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton_key),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE vault_memberships (
  vault_id uuid NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  invited_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (vault_id, user_id)
);

CREATE INDEX vault_memberships_user_idx ON vault_memberships (user_id, vault_id);

CREATE TABLE photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults (id) ON DELETE RESTRICT,
  uploaded_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  media_type text NOT NULL CHECK (media_type IN ('IMAGE', 'VIDEO')),
  status text NOT NULL CHECK (status IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED')),
  original_object_key text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  captured_at timestamptz,
  captured_timezone_offset_minutes smallint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  processing_error_code text,
  processing_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX photos_vault_status_created_idx ON photos (vault_id, status, created_at DESC, id DESC);
CREATE INDEX photos_processing_idx ON photos (status, updated_at, id)
  WHERE status IN ('UPLOADED', 'PROCESSING');
CREATE INDEX photos_uploader_idx ON photos (uploaded_by_user_id);

CREATE TABLE photo_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id uuid NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('THUMBNAIL_SM', 'THUMBNAIL_MD', 'DISPLAY')),
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (photo_id, kind)
);

CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id uuid NOT NULL REFERENCES vaults (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  order_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE INDEX collections_vault_active_idx
  ON collections (vault_id, created_at DESC, id DESC) WHERE archived_at IS NULL;
CREATE INDEX collections_vault_archived_idx
  ON collections (vault_id, archived_at DESC, id DESC) WHERE archived_at IS NOT NULL;
CREATE INDEX collections_creator_idx ON collections (created_by_user_id);

CREATE TABLE collection_photos (
  collection_id uuid NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  photo_id uuid NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  position bigint NOT NULL CHECK (position > 0),
  added_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, photo_id),
  CONSTRAINT collection_photos_position_unique
    UNIQUE (collection_id, position) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX collection_photos_feed_idx
  ON collection_photos (collection_id, position, photo_id);

CREATE TABLE favorites (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  photo_id uuid NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, photo_id)
);

CREATE INDEX favorites_feed_idx ON favorites (user_id, created_at DESC, photo_id DESC);

-- Down migration:
-- DROP TABLE favorites, collection_photos, collections, photo_assets, photos,
--   vault_memberships, vaults;
-- ALTER TABLE users DROP COLUMN approval_status, DROP COLUMN approved_at,
--   DROP COLUMN approved_by_user_id, DROP COLUMN is_app_admin;
