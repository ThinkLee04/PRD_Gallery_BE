# Backend modules

Backend code is organized **by domain** (docs/technical-spec.md §4), not by
technical layer. Within each module keep routes, schemas (TypeBox), services /
business logic, and repository/data access close together. Avoid a generic
"god service" or global repository layer.

Intended modules:

- `health` — implemented (liveness/readiness)
- `auth` — implemented: Google OAuth/OIDC login, opaque server-stored
  sessions (SHA-256 hashed tokens in `sessions`), `GET /v1/me`,
  `POST /auth/logout`
- `users` — implemented (user records upserted by Google `sub`)
- `vaults`, `memberships` — singleton vault, approval, and the authorization
  source of truth (`OWNER` / `MEMBER`)
- `photos`, `uploads` — cursor gallery metadata, direct-to-R2 originals,
  signed delivery, and in-process derivative generation
- `collections`, `favorites` — shared ordered Albums and private Loved state
- `compare` — placeholder for future client-side comparison
