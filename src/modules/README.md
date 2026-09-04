# Backend modules

Backend code is organized **by domain** (docs/technical-spec.md §4), not by
technical layer. Within each module keep routes, schemas (TypeBox), services /
business logic, and repository/data access close together. Avoid a generic
"god service" or global repository layer.

Intended modules:

- `health` — implemented (liveness/readiness)
- `auth` — Google OAuth/OIDC, sessions (server-stored, hashed tokens)
- `users` — user records keyed by Google `sub`
- `vaults` — vaults, owner-only configuration
- `memberships` — the authorization source of truth (`OWNER` / `MEMBER`)
- `photos` — photo metadata + lifecycle (never image bytes)
- `uploads` — direct-to-R2 presigned upload orchestration
- `collections`, `favorites`, `compare` — organization/presentation features

Placeholder folders exist so the layout is explicit; they contain no code yet.
Do not pre-build features (see `docs/technical-spec.md` §18).
