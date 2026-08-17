# Deployment

This document covers what Phase 19 (§19.19–§19.22) calls "production
readiness": how to stand the app up from a clean checkout, what CI gates it
before merge, what `/api/health` actually checks, and how to recover from
data-loss scenarios. It assumes the reader has already read `README.md`'s
local-development setup — this document is about running the same stack in
production, not a different stack.

## 1. Production deployment, step by step

These steps are exactly what `.github/workflows/ci.yml` runs (minus
`next start`), so a passing CI run is strong evidence a real deployment
following the same steps will also succeed.

1. **Provision PostgreSQL 16+ with the `vector` extension.** See README.md
   §1 for the exact `CREATE EXTENSION` / `trusted` setup if the app's DB
   role isn't a superuser. Managed Postgres providers that ship pgvector
   (e.g. Supabase, Neon, RDS with the extension enabled) work the same way.
2. **Provision durable storage for two directories** — `STORAGE_ROOT`
   (uploaded course PDFs) and `AUDIO_STORAGE_ROOT` (generated Tutor audio).
   These are plain server-side directories (see `src/lib/storage/`), not S3
   by default — if the deployment target has an ephemeral filesystem
   (most PaaS containers), point both at a mounted persistent volume, or
   swap in a new `StorageProvider` implementation (the interface in
   `src/lib/storage/storage.ts` is the only thing that needs a second
   implementation — nothing else references the filesystem directly).
3. **Set environment variables.** Copy `.env.example` (tracked in the repo
   specifically so this step doesn't require guessing) and fill in the
   real values — at minimum `DATABASE_URL` and `ANTHROPIC_API_KEY`; every
   other variable has a documented default. Never commit the filled-in
   `.env` itself.
4. **Install dependencies.** `npm ci`. This triggers `postinstall` →
   `prisma generate`, which regenerates `src/generated/prisma` from
   `prisma/schema.prisma` — the app will not build without this step, and
   it must be re-run after every schema change (it is not itself something
   to commit; `src/generated/prisma` is gitignored).
5. **Apply migrations.** `npm run db:deploy` (`prisma migrate deploy`).
   This is the production-safe command — unlike `prisma migrate dev`, it
   never generates new migrations or resets data, only applies whatever's
   already in `prisma/migrations/` that the target database hasn't seen
   yet. See §4 below before running this against a database with real
   student data.
6. **Build.** `npm run build` (`next build`). Static assets are emitted
   under `.next/` by the Next.js build itself — there is no separate asset
   pipeline to run.
7. **Start.** `npm start` (`next start`). Confirm the deployment is
   actually healthy by hitting `/api/health` (§3 below) rather than just
   checking the process is running — a process that started but can't
   reach the database will still respond to a bare TCP health check.

Every step above is exactly reproducible from a clean `git clone` — nothing
in this list depends on the sandbox's local state.

## 2. Environment variables

`.env.example` is the source of truth (kept in sync with
`src/lib/env.ts`'s Zod schema, which is itself the source of truth for
defaults and validation — if the two ever disagree, trust `env.ts`). A few
deserve explicit callouts beyond what's in the file's own comments:

- `ANTHROPIC_API_KEY` is schema-optional (so the app can boot without it —
  e.g. this sandbox's own test environment runs with it unset) but every
  AI-dependent feature will fail at call time without it, and `/api/health`
  reports `configuration: error` when it's missing. Set it for any real
  deployment.
- `TTS_ENABLED` defaults to `false`; leave it that way unless `TTS_API_KEY`
  is also set — the health check flags `TTS_ENABLED=true` with no key as a
  configuration error.
- `STORAGE_ROOT` / `AUDIO_STORAGE_ROOT` default to relative paths under the
  working directory. In any deployment where the working directory isn't
  guaranteed stable/persistent across restarts (containers especially),
  set these to absolute paths on a mounted volume.
- `SHADOW_DATABASE_URL` is only used by `prisma migrate dev` (local
  development, for drift detection) — production's `prisma migrate deploy`
  never touches it, so it doesn't need to exist in a production
  environment at all.

## 3. `/api/health`

`src/lib/health.ts` implements three independent, local checks — it
**never calls Claude or the TTS provider** to answer "is this app
healthy," since an external API being slow or rate-limited is a different
question from "is this deployment up," and paying for/waiting on a live AI
call on every health probe (load balancers hit this endpoint frequently)
would be wasteful and would make the health check itself a source of AI
cost and latency.

- **database** — `SELECT 1` against the configured `DATABASE_URL`.
- **storage** — both storage roots exist and are writable (`fs.mkdir` +
  `fs.access`, not a real file write).
- **configuration** — required env vars are present for whichever features
  are actually enabled (`ANTHROPIC_API_KEY`; `TTS_API_KEY` only if
  `TTS_ENABLED=true`).

The response is `{ status: "healthy" | "degraded", checks: {...},
timestamp }`, HTTP 200 when healthy and 503 when any check fails — wire a
load balancer / orchestrator's health probe to the status code, not the
response body, so a check failure actually takes the instance out of
rotation. No check's error `message` ever includes the raw underlying
error (connection strings, file paths, credentials) — see
`tests/services/health.test.ts` for the regression tests proving that.

## 4. Production data safety

### Migrations

- **Backup before every migration.** `prisma migrate deploy` applies
  schema changes directly; there is no automatic backup step built into
  it. Take a database snapshot (§ below) immediately before running it
  against a database with real data — this is a manual precondition, not
  something the app enforces for you.
- **A failed migration is recoverable, not catastrophic**, as long as the
  backup precondition above was followed: `prisma migrate deploy` runs
  each pending migration in order and stops at the first failure, so a
  database backed up beforehand can simply be restored and the failing
  migration fixed before retrying — no partial, half-migrated state needs
  to be hand-repaired if you restore rather than patch forward.
- **Rollback guidance**: Prisma has no built-in "undo" for an applied
  migration. The supported rollback path is: restore the pre-migration
  backup, then fix and re-run the migration. Do not hand-write a reverse
  migration against a database that already has post-migration writes in
  it (from Phase 19 §19.5's append-only tables especially —
  `KnowledgeEvidence`, `LearningAttempt`, `ReviewEvent`,
  `StudentMisconception`, `AiUsageLog`, `TtsUsageLog` — those are never
  meant to be edited after the fact, and a hand-rolled rollback script is
  the most likely way to accidentally do exactly that).

### Database backups

- Use your Postgres provider's native backup mechanism (managed providers:
  automated snapshots + point-in-time recovery; self-hosted: `pg_dump` on
  a schedule, or WAL archiving for point-in-time recovery). This app has
  no bespoke backup tooling of its own — there's no reason to build one
  when Postgres's own tooling already solves this correctly.
- Back up before every migration (above) at minimum; a production
  deployment should also have a regular independent schedule (e.g. daily)
  so a non-migration incident (bad manual query, disk failure) isn't only
  covered by pre-migration snapshots.

### Storage backups

- `STORAGE_ROOT` (uploaded PDFs) and `AUDIO_STORAGE_ROOT` (generated TTS
  audio) are not covered by a database backup — back up the storage
  volume itself (a snapshot of the mounted volume, or a periodic sync to
  object storage). `AUDIO_STORAGE_ROOT` is fully regenerable from its
  source `TutorMessage` rows (it's a cache — see
  `TutorMessageAudio`/`checkAudioStorageIntegrity()` in
  `src/lib/storage/integrity.ts`), so it's lower priority than
  `STORAGE_ROOT`, whose PDFs are the only copy of a student's uploaded
  course material.
- After restoring either the database or storage independently (e.g. a
  storage-volume restore that's older than the database), run
  `checkDocumentStorageIntegrity()` / `checkAudioStorageIntegrity()`
  (`src/lib/storage/integrity.ts`) to find the resulting mismatches —
  DB rows whose file is now missing, or files with no DB row — before
  assuming the restore is complete.

### Disaster recovery

1. Restore the database from the most recent backup/snapshot.
2. Restore `STORAGE_ROOT` and `AUDIO_STORAGE_ROOT` from their most recent
   volume backup.
3. Run the storage integrity checks (above) to find any mismatch between
   the two restores (they were not necessarily taken at the same instant).
4. For any `missingFiles` entry pointing at a `Document`, the document's
   `processingStatus` should be treated as unrecoverable for that file —
   the student needs to re-upload it. For any `orphanFiles` entry, it's
   safe to delete (nothing references it).
5. Hit `/api/health` to confirm database + storage are both reachable
   before reopening traffic.

### Data retention

- Append-only history tables (`KnowledgeEvidence`, `LearningAttempt`,
  `ReviewEvent`, `StudentMisconception`, `AiUsageLog`, `TtsUsageLog` — see
  Phase 19 §19.5) are never pruned by the application itself; they grow
  indefinitely by design, since they're the evidence trail the mastery
  model and cost/usage dashboards are computed from. If a retention policy
  is ever needed (e.g. for storage cost or a privacy requirement), it
  should be a separate, explicit, operator-run process — not a change to
  application code that silently starts deleting rows other code assumes
  are permanent.
- Deleting a `User` cascades to delete every row that references it
  (courses, documents, mastery, sessions, exams, usage logs — see the
  `onDelete: Cascade` relations in `prisma/schema.prisma`). There is
  currently no soft-delete/undo for this; treat user deletion as
  irreversible.

## 5. CI quality gate

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request: `prisma generate` → `prisma migrate deploy` (against a real
`pgvector/pgvector:pg16` service container, so a broken migration fails CI
the same way it would fail a real deploy) → `typecheck` → `lint` → the full
`vitest` suite → `next build`. Configure the repository's branch
protection to require this workflow before merge — the workflow existing
is necessary but not sufficient; it only gates anything once it's marked
as a required status check.
