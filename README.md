# Photo Vault API

Back-end for the Shared Private Photo Vault — a **modular monolith** built with
Node.js + TypeScript + Fastify. See `../docs/technical-spec.md` for the
architecture contract and `../.github/instructions/backend.instructions.md` for
backend coding rules.

> Status: authentication, approval, singleton-vault membership, shared
> Collections, private Loved photos, direct R2 uploads, derived images, and
> cursor gallery delivery are implemented. Compare remains future work.

## Stack

- Fastify 5 + TypeScript (strict, NodeNext/ESM)
- PostgreSQL via `pg`; SQL migrations in `migrations/`
- Validation/serialization schemas with TypeBox
- Tests with Vitest; lint/format with Biome

## Layout

```text
src/
├─ config.ts              # typed env config, fail-fast validation
├─ app.ts                 # Fastify assembly: plugins, errors, modules
├─ server.ts              # entrypoint (loopback bind, graceful shutdown)
├─ lib/
│  ├─ errors.ts           # stable error codes + ApiError
│  └─ error-handler.ts    # standard { error: { code, message, requestId } } envelope
├─ db/
│  ├─ pool.ts             # lazy pg pool + readiness check
│  └─ migrate.ts          # SQL migration runner
└─ modules/
   ├─ health/             # GET /health, GET /ready (implemented)
   └─ <domain>.../        # auth, users, vaults, memberships, photos, ...
migrations/               # timestamped *.sql migrations
```

## Commands

```bash
npm install
npm run dev            # tsx watch
npm run migrate        # apply pending migrations (requires DATABASE_URL)
npm run test           # vitest
npm run typecheck      # tsc --noEmit
npm run lint           # biome check
npm run build          # tsc -> dist/
npm start              # node dist/server.js
```

## Configuration

Copy `.env.example` to `.env` and fill in values. The server fails fast on
invalid config and binds to `127.0.0.1` (Caddy is the public entry point).
Google OAuth keys, `APP_BASE_URL`, and `SESSION_SECRET` are required at boot.
Production also requires `APP_ADMIN_EMAILS` and the private R2 settings shown
in `.env.example`; video metadata processing requires `ffprobe`.
`GET /health` is liveness (no DB needed); `GET /ready` reports database
readiness (503 + `not_configured` when `DATABASE_URL` is absent).

## Migrations

- Create: `npm run migrate:create -- <snake_case_name>`
- Apply: `npm run migrate` (runs pending files in order; tracked in
  `schema_migrations`, each file in its own transaction)
- Down migrations are recorded as comments for reference and are not executed
  automatically (dev/prod migrations are forward-only by default).

## Non-negotiables honored here

- No Docker, Redis, queues, or microservices.
- Image bytes are never stored in Postgres or proxied through the API;
  uploads/downloads use short-lived, membership-authorized R2 URLs.
- Originals are write-once and never deleted or recompressed; thumbnails are
  separate derivative objects.
- Secrets live only in environment configuration, never in code or logs.
