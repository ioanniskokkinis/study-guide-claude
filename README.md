# AI Study Coach

An adaptive AI tutor that builds a persistent model of what a student knows,
diagnoses gaps, and chooses the next best learning action — not a chatbot
with PDFs attached.

This repo is built in phases (see `PHASES.md` for status). **Phases 1–2
(foundation, course ingestion) are complete**; the knowledge graph and the
adaptive study modes described in the full product spec ship in later
phases.

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- PostgreSQL + Prisma (driver adapters, `@prisma/adapter-pg`)
- pgvector for embeddings (schema is in place; nothing writes embeddings yet)
- `pdf-parse` for deterministic, server-side PDF text extraction (no OCR yet)
- Anthropic Claude API (server-side only — the frontend never sees the key;
  not called yet — ingestion in Phase 2 is deliberately non-AI)
- Vitest for unit/integration tests

## Local development setup

### 1. PostgreSQL + pgvector

You need a Postgres server (16+) with the `vector` extension available.

```bash
# Debian/Ubuntu
sudo apt-get install -y postgresql-16-pgvector
```

The app's database role is **not** a superuser, so `CREATE EXTENSION vector`
needs the extension marked `trusted` (Postgres 13+), otherwise only a
superuser can install it. One-time setup as a Postgres superuser:

```sql
-- mark pgvector as installable by non-superusers with CREATE on the DB
-- (edit /usr/share/postgresql/16/extension/vector.control, add: trusted = true)

CREATE ROLE study_coach LOGIN PASSWORD 'study_coach_dev_password' CREATEDB;
CREATE DATABASE study_coach OWNER study_coach;
CREATE DATABASE study_coach_shadow OWNER study_coach; -- used by `prisma migrate dev`
```

Then, as the `study_coach` role (or any role with CREATE on the database):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

`CREATEDB` is granted so `prisma migrate dev`'s shadow-database workflow
works locally; it is not required for `prisma migrate deploy`.

### 2. Environment

```bash
cp .env.example .env
# fill in DATABASE_URL / SHADOW_DATABASE_URL if different from the defaults,
# and ANTHROPIC_API_KEY once AI features are exercised (Phase 5+)
```

### 3. Install, migrate, run

```bash
npm install
npm run db:migrate   # prisma migrate dev — local development
npm run dev
```

Visit `http://localhost:3000` (shows live DB connectivity), `/courses` to
create a course and upload PDFs, and `http://localhost:3000/api/health`.

There is no real authentication yet — every request is scoped to a single
`DEV_USER_EMAIL` user (`src/lib/auth/dev-user.ts`), upserted on first use.

## Course ingestion (Phase 2)

`POST /api/courses/:id/documents` accepts a `multipart/form-data` upload
with a `file` field and runs it through a synchronous pipeline (no queue —
see `src/lib/documents/document-processor.ts`): validate → store on the
local filesystem → extract text (`pdf-extractor.ts`) → chunk deterministically
(`chunker.ts`, paragraph/sentence/word-aware, configurable size + overlap,
no LLM calls) → mark the `Document` `READY` with its `DocumentChunk` rows,
or `FAILED` with a `processingError`. Uploaded files live under
`STORAGE_ROOT` and are never served through a public URL; API responses omit
the internal `storagePath`/`filename` fields.

API surface:

```
POST   /api/courses                    create a course
GET    /api/courses                    list the current user's courses
GET    /api/courses/:id                course detail + its documents
DELETE /api/courses/:id                delete a course (cascades documents/chunks, removes files)
POST   /api/courses/:id/documents      upload + process a PDF
GET    /api/documents/:id              document detail (status, extracted text, chunk count)
DELETE /api/documents/:id              delete a document (removes its file)
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:migrate` | Create/apply a migration locally (uses the shadow DB) |
| `npm run db:deploy` | Apply pending migrations without a shadow DB (CI/prod) |

## Project layout

```
src/
  app/
    courses/                       Courses list, course detail, document detail pages
    api/courses, api/documents/    Route handlers (see API surface above)
  components/courses, documents/   Client components (upload, delete, forms)
  lib/
    ai/                Server-side Claude service, prompts, and AI subsystems (not wired up yet)
      prompts/         Prompt templates, kept out of React components
    auth/              Single-user dev-user stand-in until real auth exists
    db/                Prisma client singleton
    documents/          pdf-extractor.ts, chunker.ts, document-processor.ts, validation.ts
    services/          Ownership-checked course/document business logic
    storage/           Storage abstraction (local FS now, S3-compatible later)
    env.ts             Validated environment configuration
  generated/prisma/    Generated Prisma client (gitignored)
prisma/
  schema.prisma        Full domain model (users, courses, concepts, mastery, ...)
  migrations/
tests/                 Vitest unit/integration tests (real Postgres, no mocks)
storage/uploads/       Local dev file storage (gitignored)
```

**Note:** `pdf-parse` (via `pdfjs-dist`) resolves its worker script relative
to its own package files, so it must run unbundled — `next.config.ts` marks
it as a `serverExternalPackages` entry. Bundling it breaks PDF extraction
only in `next build`/`next start`, not in `next dev` or Vitest, so this is
easy to miss without a production build check.

Full product/technical specification and phase breakdown lives in the
project's issue history; `PHASES.md` tracks what has shipped.
