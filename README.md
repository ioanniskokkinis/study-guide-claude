# AI Study Coach

An adaptive AI tutor that builds a persistent model of what a student knows,
diagnoses gaps, and chooses the next best learning action — not a chatbot
with PDFs attached.

This repo is built in phases (see `PHASES.md` for status). **Phases 1–5
(foundation, course ingestion, knowledge graph, student knowledge model,
Active Recall) are complete**; the remaining adaptive study modes
described in the full product spec ship in later phases.

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- PostgreSQL + Prisma (driver adapters, `@prisma/adapter-pg`)
- pgvector for embeddings (schema is in place; nothing writes embeddings yet)
- `pdf-parse` for deterministic, server-side PDF text extraction (no OCR yet)
- Anthropic Claude API (server-side only, via `client.messages.parse()` +
  `zodOutputFormat` for schema-validated structured JSON — see
  [Knowledge graph](#knowledge-graph-phase-3) below)
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
# and ANTHROPIC_API_KEY to exercise "Build Knowledge Graph" (Phase 3+)
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

## Knowledge graph (Phase 3)

`POST /api/courses/:id/knowledge/build` runs a course's `READY` document
chunks through a synchronous pipeline (`src/lib/knowledge/knowledge-builder.ts`,
no queue, same philosophy as Phase 2's document processing):

```
chunks → concept extraction (batched, Claude Haiku)
       → deterministic normalization + dedup (case/whitespace/punctuation)
       → AI-assisted near-duplicate merge (conservative, high-confidence only)
       → relationship extraction (Claude Sonnet)     ─┐
       → prerequisite extraction (Claude Sonnet)      ├─ confidence-gated, evidence-required
       → graph validation (self-ref / duplicate / cycle rejection)
       → one transaction: delete + recreate the course's graph (idempotent rebuild)
```

Every Claude call goes through `src/lib/ai/claude.ts#extractStructured()`,
which uses `client.messages.parse()` + `zodOutputFormat()` for
schema-validated structured JSON (never raw-parsed, never trusted
un-validated) and logs every call to `AiUsageLog` for cost tracking. Prompts
live under `src/lib/ai/prompts/`, never inline in components.

**Direction convention:** a `ConceptRelationship` with
`relationshipType: "prerequisite"` means `sourceConcept` is a prerequisite
*for* `targetConcept` (source must be learned first). Don't reason about
source/target directly — use `getConceptDetail()` in
`src/lib/services/knowledge.ts`, which exposes `prerequisites` / `usedBy` /
`related` already resolved in the right direction.

**Idempotency:** rebuilding a course's graph always deletes and recreates
it in one transaction (`src/lib/knowledge/persist.ts`), rather than
incrementally merging — running it twice never duplicates data.

API surface:

```
POST   /api/courses/:id/knowledge/build      run/rerun extraction for a course
GET    /api/courses/:id/knowledge            status + concept/relationship/prerequisite counts
GET    /api/courses/:id/knowledge/concepts   server-side paginated concept search (?q=, ?page=)
GET    /api/courses/:id/knowledge/graph      graph nodes/edges (?types=prerequisite,related,...)
GET    /api/concepts/:id                     concept detail: sources, prerequisites, used-by, related
```

UI: `/courses/:id/knowledge` (build button, counts, filterable graph
visualization, concept search) and `/concepts/:id` (full detail with
click-to-expand evidence/confidence per relationship).

**Known limitation:** exercising the actual Claude calls needs a real
`ANTHROPIC_API_KEY` — this dev sandbox doesn't have one, so the pipeline
was verified by (a) unit/integration tests with a mocked Claude client for
every extraction/validation/persistence step, including a real-Postgres
idempotency test, and (b) a manual end-to-end pass against the running
server with the graph read-side (search, filters, graph endpoint, concept
detail, ownership checks) exercised against real seeded data, and the
build-trigger's failure path (missing key → `FAILED` status with a clear
error, no crash) verified live.

## Student knowledge model (Phase 4)

Strictly separate from Phase 3's course knowledge graph: `Concept` /
`ConceptRelationship` describe what the material teaches; everything below
describes what a specific student knows, scoped to `(userId, conceptId)`.
Never a boolean — every concept tracks four independent dimensions
(recall/explanation/application/transfer) plus a separately-stored
confidence score, and a `StudentConceptMastery` row is only created lazily,
on first evidence. **Absence of a row means `UNKNOWN` ("not enough evidence
yet"), never "doesn't know it."**

```
LearningAttempt (full history, never overwritten)
  → KnowledgeEvidence (one outcome-scored observation)
  → StudentMistake[] (only if the attempt revealed one — category
    distinguishes a knowledge GAP, "doesn't know yet," from a
    MISCONCEPTION, "confidently knows it wrong")
  → StudentConceptMastery update (deterministic, never AI-driven)
```

`src/lib/learning/record-outcome.ts#recordLearningOutcome()` is the single
entry point that does all four atomically — this is what Phase 5's
question/answer/evaluation loop will call. Mastery itself comes from
`src/lib/learning/mastery-engine.ts`: a swappable `MasteryStrategy`
(`WeightedEvidenceStrategy` is the only implementation so far) computes
`newScore = oldScore * (1 - w) + newEvidence * w` per dimension — an EMA,
so recent evidence always outweighs any single older data point without
needing a separate history table for "current" mastery. Status
(`UNKNOWN → LEARNING/DEVELOPING → STRONG → MASTERED`, or
`NEEDS_REMEDIATION`) requires both a score threshold *and* a minimum
attempt/success count — one lucky or unlucky answer never flips it.
`src/lib/learning/confidence-calibrator.ts` compares self-reported
confidence against correctness to flag "confidently wrong" (misconception
signal) vs. "unsure but correct" (fragile knowledge) — not full statistics,
just spec-scoped arithmetic.

Read side (`src/lib/services/student-knowledge.ts`) is ownership-checked
like every other service and includes `getPrerequisiteStatus()` — a
recursive, cycle-safe (per-path visited set, diamond-shaped DAGs still
resolve correctly) walk of a concept's prerequisite chain paired with this
student's mastery of each link, and `getKnowledgeSnapshot()`, the
aggregate `{overallMastery, strong/weak/unknownConcepts, misconceptions,
prerequisiteGaps, recentFailures, calibration}` view meant as input for a
future adaptive engine (Phase 6+), not a UI-specific payload.

API surface:

```
GET   /api/concepts/:id/mastery                    mastery + prerequisite chain for one concept
GET   /api/concepts/:id/evidence                    evidence history for one concept
GET   /api/courses/:id/student-knowledge            aggregate knowledge snapshot
GET   /api/courses/:id/student-knowledge/mistakes   mistake list (?unresolvedOnly=true)
PATCH /api/mistakes/:id                              mark a mistake reviewed (never touches mastery)
```

UI: the course dashboard and `/courses/:id/knowledge` both show a "My
Knowledge" section (overall mastery %, Strong/Developing/Weak/Unknown
buckets, prerequisite-gap callouts, a resolvable mistake list); `/concepts/:id`
splits into a visually distinct "Course Knowledge" section (unchanged from
Phase 3) and a "My Knowledge" section (dimension breakdown, confidence,
attempts, recent evidence, mistakes).

**Known limitation:** there's no UI yet to generate learning attempts
(Active Recall / Socratic / exams all ship in later phases), so Phase 4 was
verified with real-Postgres integration tests plus a manual pass that
drove `recordLearningOutcome()` directly against the running server and
confirmed the resulting mastery, prerequisite-gap detection, and UI
rendering against real (not hardcoded) data.

## Active Recall (Phase 5)

The first complete learning loop: select a concept → get a question →
answer from memory → Claude evaluates → mastery updates → next question
reacts to how you did. The explanation is never shown before an attempt —
retrieval always comes first.

```
question-selector.ts    picks a concept (prerequisite gaps > weak >
                         developing > recent mistakes > unknown > strong,
                         spec §8/§31 — not yet the full study planner)
        ↓
question-generator.ts   reuse-before-generate; grounds new questions in
                         real source chunks via extractStructured, refuses
                         rather than inventing facts if material is thin,
                         and rejects exact/near-duplicate prompts (§24)
        ↓
answer-evaluator.ts     Claude scores CORRECT/PARTIAL/INCORRECT (never a
                         boolean), separates misconceptions ("confidently
                         wrong") from plain gaps, and can flag a
                         prerequisite gap — but only if it names a
                         prerequisite that's actually in this concept's
                         real graph edges (never invented, §14)
        ↓
record-outcome.ts       Phase 4's existing deterministic entry point —
                         the evaluator never touches mastery directly
        ↓
difficulty-engine.ts    last-3-attempts window, ±1 level at 85%/60%
                         thresholds, clamped [1,5], never from one answer
```

`study-session.ts` orchestrates all of it plus the session lifecycle
(start/resume, hint, reveal, next, complete) and is the only place that
calls the AI/DB layers together — routes and UI never do. A revealed or
hinted answer is tracked distinctly (`revealCount`/`hintCount`,
`revealedAnswer`/`usedHint` on the resulting attempt) and never scored as
an unaided success. Submitting an answer persists it *before* calling
Claude, so an evaluation failure never loses the student's work — the
route returns a friendly "please try again" and a retry reuses the same
saved answer rather than creating a duplicate.

API surface:

```
POST /api/courses/:id/study/recall/session   start or resume the active session for this course
GET  /api/courses/:id/study/recall/active    { sessionId | null } — no AI call, used to silently resume on page load
GET  /api/study-sessions/:id                 full session + current question/answer state (survives refresh)
POST /api/study-sessions/:id/answer          submit + evaluate an answer, update mastery
POST /api/study-sessions/:id/hint            AI-generated hint (never reveals the answer)
POST /api/study-sessions/:id/reveal          reveal the answer (zero-credit, non-successful outcome)
POST /api/study-sessions/:id/next            next question — retry (same concept, easier) or fresh selection
POST /api/study-sessions/:id/complete        end the session, return its summary
GET  /api/study-sessions/:id/summary         re-fetch a completed session's summary
```

UI: `/courses/:id/study/recall` (linked from the course dashboard once its
knowledge graph is `READY`).

Model selection per AI task is configurable (`AI_MODEL_QUESTION_GENERATION`,
`AI_MODEL_ANSWER_EVALUATION`, `AI_MODEL_HINT_GENERATION` — each picks the
`"fast"`/`"default"` tier from `src/lib/ai/claude.ts`, so the underlying
model IDs stay centralized in `ANTHROPIC_MODEL_FAST`/`ANTHROPIC_MODEL_DEFAULT`).
Every Claude call is attributed to a distinct `AiUsageLog` `requestType`
(`QUESTION_GENERATION`, `REMEDIATION` for retry-driven regeneration,
`ANSWER_EVALUATION`, `HINT_GENERATION`) and wrapped in bounded
exponential-backoff retry (`src/lib/ai/retry.ts`). A simple in-memory
per-user rate limiter (`src/lib/rate-limit.ts`) guards the AI-calling
routes against accidental rapid-fire clicks.

**Known limitation:** as with Phase 3/4, this sandbox has no live
`ANTHROPIC_API_KEY`, so the question-generation/evaluation/hint pipeline
was verified with a mocked Claude client (grounding/refusal/duplicate-
detection, evaluation mapping, prerequisite-gap validation, the full
session lifecycle including hints/reveal/security) plus a live pass
against the running server: the missing-key failure path returns a clean
error with no orphaned session left behind, and the deterministic
reveal→outcome→mastery→summary path (which needs no AI call) was
exercised end-to-end against real Postgres.

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
    courses/                          Courses list, course/document/knowledge-graph/recall pages
    concepts/[id]/                    Concept detail page
    api/courses, api/documents/,
    api/concepts/, api/study-sessions/,
    api/mistakes/                     Route handlers (see API surfaces above)
  components/courses, documents/,
             knowledge/, study/        Client components (upload, delete, forms, graph viz,
                                        Active Recall session UI)
  lib/
    ai/                Server-side Claude service (claude.ts), retry.ts, answer-evaluator.ts
      prompts/         Prompt templates + their Zod output schemas, kept out of components
    auth/              Single-user dev-user stand-in until real auth exists
    db/                Prisma client singleton
    documents/          pdf-extractor.ts, chunker.ts, document-processor.ts, validation.ts
    knowledge/          concept-extractor/normalizer, relationship/prerequisite extractors,
                         graph-validator, graph-layout, persist.ts, knowledge-builder.ts
    learning/           mastery-engine.ts, confidence-calibrator.ts, record-outcome.ts (Phase 4);
                         difficulty-engine.ts, question-selector.ts, question-generator.ts,
                         study-session.ts (Phase 5 — Active Recall orchestration)
    services/          Ownership-checked course/document/knowledge/student-knowledge business logic
    storage/           Storage abstraction (local FS now, S3-compatible later)
    rate-limit.ts      Simple in-memory per-user rate limiter for AI-calling routes
    env.ts             Validated environment configuration
  generated/prisma/    Generated Prisma client (gitignored)
prisma/
  schema.prisma        Full domain model (users, courses, concepts, mastery, ...)
  migrations/
tests/                 Vitest unit/integration tests (real Postgres; Claude client mocked
                        where a live API call would otherwise be required)
storage/uploads/       Local dev file storage (gitignored)
```

**Note:** `pdf-parse` (via `pdfjs-dist`) resolves its worker script relative
to its own package files, so it must run unbundled — `next.config.ts` marks
it as a `serverExternalPackages` entry. Bundling it breaks PDF extraction
only in `next build`/`next start`, not in `next dev` or Vitest, so this is
easy to miss without a production build check.

Full product/technical specification and phase breakdown lives in the
project's issue history; `PHASES.md` tracks what has shipped.
