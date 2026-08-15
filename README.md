# AI Study Coach

An adaptive AI tutor that builds a persistent model of what a student knows,
diagnoses gaps, and chooses the next best learning action — not a chatbot
with PDFs attached.

This repo is built in phases (see `PHASES.md` for status). **Phases 1–9
(foundation, course ingestion, knowledge graph, student knowledge model,
Active Recall, adaptive engine, intelligent tutor, exam & assessment
engine, spaced repetition) are complete**; the remaining study modes
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

## Adaptive learning engine (Phase 6)

Answers "given everything we know about this student, what's the
highest-value thing to do next?" — deterministically. **Zero Claude calls**:
every recommendation comes from PostgreSQL (mastery, attempts, mistakes,
the prerequisite graph) run through composable scoring functions, not a
model call. Claude stays scoped to *generating content* (Phase 5's question
generation/evaluation); *deciding what to study* is plain arithmetic —
cheaper, deterministic, and explainable.

```
src/lib/learning/adaptive/
  student-state.ts     targeted queries -> StudentLearningState (spec §39,
                        never "SELECT everything")
  concept-scoring.ts   per-concept: weakness, prerequisite blocking
                        (recursive, depth-limited, cycle-safe), prerequisite
                        importance, recency/severity-weighted mistake
                        pressure, a mastery-scaled forgetting-risk decay
                        model, exam-goal urgency, recency/interleaving
                        penalty -> combined into one 0-1 concept value
  action-scoring.ts    per-action-type: scoreActiveRecall/scoreRemediation/
                        scorePrerequisiteReview/scoreReview/scoreChallenge,
                        each 0-1 — repeated-failure and success-streak
                        windows, and a severe-misconception override that
                        beats even high stale mastery (spec §22)
adaptive-engine.ts      composes the above: getStudentState ->
                        calculateConceptScores -> generateCandidateActions
                        -> rankActions -> explainDecision -> the single
                        entry point, getNextLearningAction()
```

A `PREREQUISITE_REVIEW` candidate's concept is deliberately the *weak
prerequisite*, not the concept that triggered it — recursively found up to
5 levels up the graph, redirecting effort to the actual bottleneck (the
TCP/IP → TCP → Ports → Firewalls → Network Attacks chain: if Firewalls is
weak because Ports is weaker still, the recommendation is Ports). Every
call is logged to `AdaptiveDecisionLog` for later recommendation → action →
outcome analysis; `accepted` is set only at genuine recommendation moments
(the study dashboard's Start / Study-something-else), not on every internal
Active Recall continuation.

Active Recall (Phase 5) no longer has its own concept-selection logic — it
calls `getNextLearningAction()` for both session start and "Next Question."
"Try Again" is the one deliberate exception: it's a direct user request to
redo *this* concept, easier, so it bypasses the engine rather than asking
it to justify an override.

API surface:

```
GET   /api/courses/:id/next-action     the current recommendation (deterministic, logged)
PATCH /api/next-action/:decisionLogId  { accepted: boolean } — never forces or punishes an override
GET   /api/courses/:id/goals           list learning goals
POST  /api/courses/:id/goals           create a goal (EXAM/MASTER_COURSE/CERTIFICATION/GENERAL)
DELETE /api/goals/:id                  remove a goal
```

UI: `/courses/:id/study` — the main study dashboard (linked from the course
page's "Study" button once its knowledge graph is ready). Shows the Next
Best Action with an expandable "Why?" breakdown, an exam-date quick-setter,
a real-data progress list, and "Study something else" to pick any concept
directly instead.

**Known limitation:** same as Phases 3/5 — no live `ANTHROPIC_API_KEY` in
this sandbox, but the engine itself makes no AI calls at all, so it was
fully verified live against the running server and real Postgres,
including the exact TCP/IP→TCP→Ports→Firewalls→Network Attacks scenario
from the spec (Ports recommended first via `PREREQUISITE_REVIEW` →
improves → Firewalls becomes the target → three failures trigger
`REMEDIATION` → a fresh Ports failure re-triggers `PREREQUISITE_REVIEW`).
Only the downstream question-generation/evaluation step (unchanged from
Phase 5) needs the missing key, and it still fails cleanly (502, no
orphaned session).

## Intelligent tutor engine (Phase 7)

A chat-style tutor that decides, turn by turn, *how* to teach — not just
*what* to ask. Claude generates the language (questions, hints,
explanations, evaluations); a deterministic `TutorEngine` decides the
action. Claude never picks the next step directly — every decision goes
through `TutorDecisionSchema.parse()`, and mastery/prerequisites/
completion/session state are always application-controlled, never invented
by the model (spec §5).

```
src/lib/tutor/
  types.ts              TutorContext, TutorDecision (Zod-validated),
                         ResponseEvaluation/TeachBackEvaluation schemas
  config.ts              named thresholds (MAX_SOCRATIC_DEPTH=4,
                         REPEATED_FAILURE_THRESHOLD=3, teach-back score
                         bands, misconception resolution/decay constants,
                         hint evidence-discount factors)
  tutor-state.ts         builds TutorContext from targeted queries; reuses
                         the Phase 6 adaptive engine's own concept-value
                         calculation for prerequisite blocking rather than
                         re-deriving it
  hints.ts                deterministic hint-level state machine
                         (0/HINT_1/HINT_2/HINT_3/REVEAL) + the evidence
                         discount a hinted correct answer gets — level
                         selection needs no Claude call
  misconceptions.ts      StudentMisconception create/reinforce/decay;
                         requires multiple pieces of independent evidence
                         to resolve, never a single correct answer
  socratic.ts             Socratic mode: one question at a time, escalating
                         simplify -> hint -> hint -> hint -> explanation,
                         handing off to remediation on repeated failure
  remediation.ts          explain a small piece -> easy question -> evaluate
                         -> retry -> only increase difficulty (exit) after
                         two independent correct answers
  teach-back.ts            scores an explanation (correctness/completeness/
                         conceptualAccuracy/misconception penalty, spec
                         §20) and bands it into deepen/follow-up/remediate/
                         check-prerequisite
  decision-support.ts     shared TutorDecision-building primitives (kept
                         separate from tutor-decision.ts to avoid a
                         circular import with the three mode files above)
  tutor-decision.ts       the deterministic dispatcher: cross-cutting
                         overrides first ("just tell me", "I don't know",
                         illusion-of-competence, misconception/prerequisite
                         override, session completion), then delegates to
                         whichever mode file applies
  tutor-engine.ts         thin public facade (`TutorEngine.decide()`) over
                         tutor-decision.ts, so the engine's own file stays
                         short and readable rather than "1000 lines of
                         unexplained conditions" (spec §6)
  tutor-prompts.ts / tutor-evaluator.ts
                          every Claude call the tutor makes, each paired
                         with a Zod schema; explicit "I don't know"/"just
                         tell me" phrases are detected deterministically
                         and never reach Claude; every generator has a
                         deterministic fallback if Claude fails (spec §55)
  tutor-orchestrator.ts   the full pipeline: load state -> evaluate ->
                         record evidence -> consult the engine -> generate
                         content -> validate -> persist -> return
```

**Illusion of competence** (spec §30): a response classified INCORRECT
while the student self-reports CONFIDENT is escalated to a misconception
override rather than logged as ordinary weakness.

**Hints weaken evidence, reveal produces none of its own** (spec §24, §46):
a correct answer given after a hint is scored at a fraction of full
credit before it reaches `recordLearningOutcome()` — HINT_1 ≈ 85%, HINT_2 ≈
65%, HINT_3 ≈ 40%. A REVEAL is not an answer attempt at all, so it produces
no evidence; the mandatory retrieval question that follows it is a fresh,
independent attempt and counts at full weight.

**Prerequisite redirects and difficulty reuse Phase 6** (spec §17, §25,
§40): `tutor-state.ts` calls the adaptive engine's own
`calculateConceptValue()` for blocking detection, and difficulty comes from
Phase 5's `selectDifficultyForConcept()` — nothing here re-implements
either.

API surface:

```
POST /api/tutor/sessions                      start (or resume the active one for the same concept)
POST /api/tutor/sessions/:id/messages         submit the student's next message
POST /api/tutor/sessions/:id/hint              proactive hint (escalates one level)
POST /api/tutor/sessions/:id/teach-back        switch an in-progress session into teach-back mode
GET  /api/tutor/sessions/:id                   reconstruct the conversation after a refresh
```

UI: `/courses/:id/tutor` — pick a concept, then a simple chat: topic,
mastery, message history, a text input, a confidence selector
(confident/unsure/guessing), and Hint / "I don't know" / "Just tell me" /
"Explain it back to me" shortcuts. Linked from the study dashboard.

**Known limitation:** same as Phases 3/5/6 — no live `ANTHROPIC_API_KEY` in
this sandbox. Every Claude-backed generator has a deterministic fallback
(spec §55), so the full pipeline — session start, hint escalation through
REVEAL, misconception detection and prerequisite redirect, teach-back
scoring, and session completion — was verified live end-to-end against the
running server and real Postgres using those fallback paths; only the
*language* would be templated rather than model-generated without a key.

## Exam & assessment engine (Phase 8)

The learn → practice → **exam** → diagnose → remediate → **retest** loop.
An exam measures independent performance — no hints, explanations, or
grades leak out while it's active (spec §14, §53) — and every score,
timing check, and pass/fail decision is calculated server-side and never
trusted from the client (spec §55).

```
src/lib/exam/
  types.ts              ExamConfig/ExamBlueprint types, Zod schemas for
                         every Claude-facing structured output
  config.ts               named thresholds (diagnostic coverage ratios,
                         cognitive distribution, rubric weights, readiness
                         weights, adaptive/oral thresholds) — configurable
                         per exam, never hardcoded inline (spec §11)
  exam-blueprint.ts       deterministic coverage allocation from the
                         Student Knowledge Model: weak/unknown concepts
                         get a larger diagnostic share, strong concepts
                         are never dropped (broad coverage, spec §10),
                         and no single concept can dominate the exam
  exam-generator.ts       reuse-before-generate question generation across
                         8 formats (MC/multi-select/true-false/short
                         answer/open-ended/problem-solving/scenario/
                         teach-back) — same grounding-refusal discipline
                         as Phase 5's question-generator.ts, extended with
                         a response-format axis Question doesn't have
  exam-prompts.ts / exam-evaluator.ts
                          every Claude call: question generation, rubric
                         grading, and the oral examiner's questions —
                         each paired with a Zod schema; grading has a
                         deterministic fallback so a Claude outage never
                         blocks finishing an exam already in progress
  exam-grader.ts          deterministic scoring: multiple-choice/true-
                         false/multi-select are graded with zero Claude
                         calls; open-ended/scenario/oral answers combine
                         Claude's per-criterion rubric scores into one
                         final score via fixed weights — Claude never
                         decides the grade (spec §22-23)
  mistake-analyzer.ts     classifies each miss (knowledge gap, misconception,
                         recall/reasoning/application failure, prerequisite
                         failure, careless error, time pressure, ...) and
                         walks the full prerequisite chain on a failure
                         rather than assuming the tested concept is the
                         real gap (spec §26) — reusing Phase 4's recursive
                         getPrerequisiteStatus()
  exam-readiness.ts       ExamReadinessEngine: combines mastery, recent
                         exam performance, consistency, prerequisite
                         health, forgetting risk, and active
                         misconceptions — reusing the Phase 6 adaptive
                         engine's own scoring building blocks, never a
                         second mastery model (spec §13, §40)
  adaptive-exam.ts        per-question difficulty/concept selection for
                         ADAPTIVE mode — reacts every question (unlike
                         Active Recall's smoothed difficulty), and a wrong
                         answer pivots to checking a blocked prerequisite
                         via the adaptive engine's own findPrerequisiteBlock()
  oral-exam.ts            examiner depth progression (definition -> ...
                         -> expert reasoning) that adapts to performance
                         rather than always reaching the deepest level
  scenario-exam.ts        shapes a scenario's structured context
                         (context/objective/constraints/available
                         information) for both the UI and the grading
                         prompt
  exam-state.ts           server-computed remaining time / expiry — the
                         client's own timer is display-only (spec §16)
  exam-engine.ts          composable named steps: result aggregation
                         (concept/cognitive scores, mistake summary),
                         weak-concept identification, and the post-exam
                         recommendation (spec §44 — never "study more":
                         reuses getNextLearningAction(), since exam
                         evidence is already recorded by the time this
                         runs, refined by exam-specific mistake categories)
  exam-orchestrator.ts    the full pipeline API routes call: create ->
                         start -> answer (graded immediately, revealed
                         only after submission) -> submit (idempotent,
                         unanswered questions graded UNANSWERED) -> result
```

**Exam vs. learning mode** (spec §14): hints/reveal are off by default and,
even when explicitly enabled, are never trusted from the client —
`submitExamAnswer` zeroes out any claimed `hintsUsed`/`revealedAnswer` when
the exam itself doesn't allow them. A hinted correct answer still reaches
the Student Knowledge Model, just at reduced evidence weight; a revealed
answer produces none of its own (mirrors Phase 7's hint/reveal principle).

**Retest** (spec §46-47): `createRetest()` scopes a fresh, smaller exam to
just the weak concepts, and question reuse excludes anything this specific
user has already been asked — a different user's past question is still
fair game (saves a Claude call), but the same student never sees a
question they already saw.

API surface:

```
GET  /api/courses/:id/exams              real exam history for this course
POST /api/courses/:id/exams              create (blueprint + question generation)
POST /api/courses/:id/exams/retest       targeted retest on given weak concepts
GET  /api/courses/:id/readiness          ExamReadinessEngine output
GET  /api/exams/:id                      resume state (server-computed remaining time)
POST /api/exams/:id/start                CREATED -> ACTIVE, starts the server clock
POST /api/exams/:id/answers              save + eagerly grade one answer (never revealed yet)
POST /api/exams/:id/submit               finalize (idempotent), update the Student Knowledge Model
GET  /api/exams/:id/result               post-exam analysis, once graded
```

UI: `/courses/:id/exam` — setup form, readiness card, and history;
`/courses/:id/exam/:examId` — the exam itself (timer, question
navigation, confidence selector, an "N unanswered" submit warning);
`/courses/:id/exam/:examId/result` — score, concept/cognitive breakdowns,
per-question review, and a one-click retest; `/courses/:id/exam/oral` — a
simple text-based examiner chat (no speech-to-text provider is already
wired into this project, so this is the text fallback the spec asks for).

**Known limitation:** same as Phases 3/5/6/7 — no live `ANTHROPIC_API_KEY`
in this sandbox. Unlike Phase 7's conversational generators, exam question
generation deliberately has **no** deterministic fallback (a fabricated
exam question would violate grounding, spec §9) — a generation failure is
a first-class, cleanly-handled outcome: the just-created `Exam` row is
deleted rather than left behind as a permanently-empty, un-resumable
orphan (mirrors Phase 5's `getOrStartSession` fix for the same class of
bug). Grading, mistake analysis, readiness, and the retest/recommendation
loop all make zero or Claude-optional calls and were fully verified live
against the running server and real Postgres, including readiness's real
numbers and the orphan-cleanup behavior itself; only question
generation/rubric grading need the missing key.

## Spaced repetition (Phase 9)

A deterministic review scheduler (`src/lib/review/`) that answers four
questions the same way every time, from persisted data alone: what's due,
when it's next due, why, and what happens after a review. Claude is never
involved in any of it — no scheduling decision in this phase makes an AI
call.

**`ReviewItem` / `ReviewEvent`.** `ReviewItem` is the persistent schedule —
one row per (student, concept), lazily created (mirroring
`StudentConceptMastery`) the first time a concept has real learning
exposure, never pre-populated for a whole course up front. `ReviewEvent` is
its append-only history: every completed review creates one row and no row
is ever updated or deleted. Both replace the unused Phase 1 `Review` stub,
which conflated a schedule and a single event and had no history table.

**The scheduler (`scheduler.ts`).** `scheduleReview({ reviewItem, outcome,
studentMastery, recentPerformance, now })` is a pure function returning the
new `{ status, interval, stability, difficulty, repetitionCount,
lapseCount, nextReviewAt }`. It folds in every factor the spec asks for:
the item's own previous interval/stability, the self-rated AGAIN/HARD/GOOD/
EASY outcome (AGAIN shrinks stability and forces a next-day review; HARD/
GOOD/EASY grow it by increasing multipliers), a 1-5 difficulty estimate
that shifts with each rating and slows or speeds future growth, repetition
count (drives graduation from LEARNING to REVIEW after two consecutive
successes) and lapse count (cumulative, never decremented), plus current
mastery and recent recall performance from the Student Knowledge Model as
bounded supporting signals — real inputs, but never able to override what
the outcome rating itself says. Every constant lives in `config.ts`.

**Due/overdue (`review-queries.ts`).** `isDue()`/`overdueDays()` are the
one canonical definition of "due" — `getDueReviews()`, the adaptive engine
integration, and the UI all call through them rather than recomputing due
state independently. `getReviewState()` returns the `{ dueCount,
overdueCount, nextReviewAt, reviewStreak }` the UI needs; `reviewStreak` is
computed from real `ReviewEvent` rows (consecutive reviewed days), not a
vanity number.

**Reuse over duplication.** A review session is a `StudySession` in a new
`REVIEW` mode — not a parallel session model. Question generation reuses
Active Recall's own `getOrGenerateQuestion` (fixed at RECALL type, since
review is pure retrieval practice); answering a review question calls the
*existing* `/api/study-sessions/:id/answer` route completely unchanged,
which still evaluates via Claude and still updates mastery through
`recordLearningOutcome()` — Phase 9 never bypasses it or opens a second
mastery-update path. The only genuinely new domain action is rating recall
quality and rescheduling (`submitReviewRating`), which runs *after*
`recordLearningOutcome()` has already recorded the evidence, matching the
architecture the spec lays out: student action → evaluation →
`recordLearningOutcome()` → student model → review scheduling.

**Idempotency.** The evaluated `LearningAttempt` id created by the answer
step is the natural idempotency key for the rating step — `ReviewEvent.
attemptId` is unique. A duplicate rating request (double-click, retry)
finds the existing event and returns it unchanged rather than rescheduling
twice; a race between two concurrent requests is caught via the unique
constraint itself, not just an up-front check.

**Adaptive engine integration.** `getStudentLearningState` now also loads
each concept's review due-state into an optional `reviewByConceptId` map;
`calculateReviewUrgencyScore()` turns overdue days into a 0-1 signal that
feeds directly into the *existing* `scoreReview()` action score alongside
the pre-existing mastery-decay `forgettingRisk` — the stronger of the two
wins. This is additive only: with no review data (the map is optional),
`scoreReview()` behaves exactly as it did in Phase 6, so nothing about the
existing adaptive engine changed for courses that never touch reviews.

**Tutor integration.** A review answer that isn't `SUCCESS` shows a direct
link into the existing Tutor in `REMEDIATION` mode for that concept — no
remediation logic is duplicated; the Tutor still owns pedagogical
intervention, the scheduler still owns scheduling.

**Exam integration.** Exam evidence reaches the scheduler for free: exam
grading already calls `recordLearningOutcome()` (Phase 8), which already
writes to the same `KnowledgeEvidence`/`LearningAttempt`/`StudentMistake`
tables the scheduler's `recentPerformance` input and the adaptive engine's
existing mistake scoring read from. Phase 9 adds no exam-specific code —
consuming existing evidence, not rewriting the exam engine, is the point.

UI: a "Reviews" card on `/courses/:id/study` (due/overdue counts, streak,
Start Review) and a `Review` link on the course page; `/courses/:id/review`
runs the session — one question at a time, reusing the same answer/hint/
reveal flow as Active Recall, followed by an AGAIN/HARD/GOOD/EASY rating
step and a real, persisted-data session summary.

**Known limitation:** same as Phases 3/5/6/7/8 — no live
`ANTHROPIC_API_KEY` in this sandbox, so review question generation/
evaluation could only be exercised via mocked-Claude integration tests
against real Postgres, not a live end-to-end run. Every deterministic
piece (scheduling, due/overdue, idempotency, the adaptive engine signal)
was verified directly.

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
    courses/                          Courses list, course/document/knowledge-graph/study/tutor/exam/review pages
    concepts/[id]/                    Concept detail page
    api/courses, api/documents/,
    api/concepts/, api/study-sessions/,
    api/mistakes/, api/goals/,
    api/next-action/, api/tutor/,
    api/exams/, api/review-sessions/   Route handlers (see API surfaces above)
  components/courses, documents/,
             knowledge/, study/, tutor/,
             exam/                      Client components (upload, delete, forms, graph viz,
                                        Active Recall session UI, adaptive dashboard, tutor chat,
                                        exam runner/results/readiness/oral examiner, review runner)
  lib/
    ai/                Server-side Claude service (claude.ts), retry.ts, answer-evaluator.ts
      prompts/         Prompt templates + their Zod output schemas, kept out of components
    auth/              Single-user dev-user stand-in until real auth exists
    db/                Prisma client singleton
    documents/          pdf-extractor.ts, chunker.ts, document-processor.ts, validation.ts
    knowledge/          concept-extractor/normalizer, relationship/prerequisite extractors,
                         graph-validator, graph-layout, persist.ts, knowledge-builder.ts
    learning/           mastery-engine.ts, confidence-calibrator.ts, record-outcome.ts (Phase 4);
                         difficulty-engine.ts, question-generator.ts, study-session.ts (Phase 5);
                         adaptive-engine.ts + adaptive/ (Phase 6 — deterministic decision engine)
    tutor/              tutor-engine.ts, tutor-decision.ts, tutor-orchestrator.ts + socratic.ts/
                         remediation.ts/teach-back.ts/hints.ts/misconceptions.ts (Phase 7)
    exam/               exam-engine.ts, exam-orchestrator.ts, exam-blueprint.ts/-generator.ts/
                         -grader.ts, mistake-analyzer.ts, exam-readiness.ts, adaptive-exam.ts/
                         oral-exam.ts/scenario-exam.ts (Phase 8)
    review/             scheduler.ts, review-queries.ts, review-orchestrator.ts (Phase 9 —
                         deterministic spaced repetition, reuses Phase 5's session/question
                         infrastructure rather than duplicating it)
    services/          Ownership-checked course/document/knowledge/student-knowledge/
                        learning-goals business logic
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
