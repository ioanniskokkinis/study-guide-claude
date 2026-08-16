# Build phases

Tracking implementation against the MVP phase plan. Build order matters —
each phase depends on the previous one's persisted data model.

- [x] **Phase 1 — Foundation.** Next.js + TypeScript + Tailwind scaffold,
      PostgreSQL + Prisma (driver adapters) + pgvector, full domain schema
      migrated, environment configuration, `/api/health`, minimal status
      page, Vitest harness.
- [x] **Phase 2 — Course ingestion.** Course CRUD, PDF upload (validated,
      stored outside the public dir), deterministic text extraction and
      paragraph-aware chunking (no LLM calls, no embeddings yet), a
      synchronous upload→extract→chunk→ready/failed pipeline, and courses
      / course-detail / document-detail pages.
- [x] **Phase 3 — Knowledge graph.** Real Claude API integration (structured
      JSON extraction via `messages.parse` + `zodOutputFormat`): batched
      concept extraction, deterministic + AI-assisted deduplication,
      relationship/prerequisite extraction with confidence gating and
      cycle-safe DAG validation, an idempotent course-level rebuild, source
      traceability, and a knowledge graph UI (search, filters, lightweight
      SVG visualization, concept detail with inspectable evidence).
- [x] **Phase 4 — Student model.** Persistent, multidimensional mastery
      (recall/explanation/application/transfer/confidence, never a boolean),
      deterministic weighted-evidence mastery engine with recency
      weighting, full learning-attempt/evidence/mistake history (never
      overwritten), misconception vs. knowledge-gap distinction, confidence
      calibration, prerequisite-aware mastery queries with cycle-safe
      recursion, a course/concept "My Knowledge" UI clearly separated from
      Phase 3's course knowledge, and `recordLearningOutcome()` as the
      single atomic entry point later phases will reuse.
- [x] **Phase 5 — Active recall.** The first end-to-end learning loop:
      grounded question generation (reuse-before-generate, duplicate
      detection), free-text answer submission, Claude-based evaluation
      (CORRECT/PARTIAL/INCORRECT, misconception vs. knowledge-gap
      detection, graph-validated prerequisite-gap flagging), deterministic
      `recordLearningOutcome()` mastery updates, basic adaptive difficulty,
      prerequisite-aware next-question selection, hints, reveal-answer,
      and a session UI with progress/summary.
- [x] **Phase 6 — Adaptive engine.** A centralized, deterministic (zero
      Claude calls) "what should I study next?" decision layer: per-concept
      weakness/prerequisite-blocking/recent-mistake/forgetting-risk/goal-
      relevance/recency scoring, composed into ranked candidate actions
      (ACTIVE_RECALL, REMEDIATION, PREREQUISITE_REVIEW, REVIEW, CHALLENGE)
      with a human-readable explanation. Active Recall now sources its
      question selection from this engine instead of its own logic; a new
      `/courses/:id/study` dashboard surfaces the recommendation with an
      accept/override choice and a real-data progress list.
- [x] **Phase 7 — Intelligent tutor engine.** A deterministic `TutorEngine`
      (`src/lib/tutor/`) that decides the next pedagogical move — ask,
      follow up, hint, explain, simplify, deepen, check a prerequisite,
      remediate, teach-back, adjust difficulty, or complete — from student
      state, never from raw Claude output. Three modes (Socratic, teach-back,
      remediation) share one engine; Socratic depth is capped and escalates
      through progressive hints before falling back to a direct explanation;
      the remediation loop explains a small piece, asks an easy question,
      and only exits after independent success. Misconceptions persist to
      `StudentMisconception` and require multiple pieces of independent
      evidence to resolve — never a single correct answer. Confident-but-wrong
      answers are flagged as an illusion-of-competence override. Prerequisite
      redirects and difficulty reuse the Phase 6 adaptive engine rather than
      duplicating its logic. Hints weaken mastery evidence progressively;
      a revealed answer produces no evidence of its own, only the mandatory
      retrieval question that follows it does. A chat-style
      `/courses/:id/tutor` UI drives the conversation end to end.
- [x] **Phase 8 — Exam & assessment engine.** A deterministic `ExamEngine`
      (`src/lib/exam/`) covering the full learn → practice → exam →
      diagnose → remediate → retest loop. `exam-blueprint.ts` allocates
      broad-but-diagnostic-tilted coverage from the Student Knowledge
      Model (weak concepts get more questions, strong ones are never
      dropped); `exam-generator.ts` produces source-grounded questions
      across 8 formats (multiple choice through scenario and teach-back)
      reusing the same grounding-refusal discipline as Phase 5;
      `exam-grader.ts` auto-grades objective formats with zero Claude
      calls and combines Claude's rubric-criterion scores into a
      deterministic final score the model never controls directly;
      `mistake-analyzer.ts` classifies failures and walks the full
      prerequisite chain rather than assuming the tested concept is the
      real gap; `exam-readiness.ts` and `adaptive-exam.ts`/`oral-exam.ts`
      reuse the Phase 6 adaptive engine's own scoring instead of a second
      mastery model. Exam mode strictly withholds hints/explanations/
      grades until submission; timing and grading are always server-side
      and idempotent. A written/scenario/adaptive exam UI, a simple
      text-based oral examiner chat, a results/readiness dashboard, and a
      one-click targeted retest round out `/courses/:id/exam`.
- [x] **Phase 9 — Spaced repetition.** A deterministic spaced-repetition
      scheduler (`src/lib/review/scheduler.ts`) — Claude never chooses a
      review date. `ReviewItem` persists one schedule per (student,
      concept); `ReviewEvent` is its append-only history, never overwritten.
      `scheduleReview()` folds in the previous interval, the self-rated
      AGAIN/HARD/GOOD/EASY outcome, difficulty, repetition/lapse counts, and
      (as bounded supporting signals) current mastery and recent recall
      performance — every factor spec-required, all constants centralized
      in `config.ts`. `review-queries.ts` is the one canonical due/overdue
      definition the UI and the adaptive engine both read. A review session
      reuses Active Recall almost entirely: it's a `StudySession` in a new
      `REVIEW` mode, question generation reuses `getOrGenerateQuestion`,
      and answering reuses the *existing* `/api/study-sessions/:id/answer`
      route unchanged — the only new domain action is rating recall
      quality and rescheduling. Rating is idempotent (a duplicate rating
      request returns the original result rather than rescheduling twice)
      via the evaluated attempt's id as the natural idempotency key. Due
      reviews feed the Phase 6 adaptive engine's existing REVIEW action
      score (never a second, competing priority system); a failed review
      links straight into the existing Tutor remediation flow; exam
      evidence already reaches the scheduler for free through the shared
      KnowledgeEvidence/LearningAttempt evidence stream Phase 8 already
      writes to. `/courses/:id/review` and a "Reviews" card on the study
      dashboard round out the UI.
- [x] **Phase 10 — Polish / MVP completion.** No new domain models and no
      redesigned architecture — every number on the new UI surfaces is
      composed from data Phases 4-9 already persist (`src/lib/dashboard/`:
      `study-plan.ts`, `notifications.ts`, `streak.ts`, `analytics.ts`,
      `sparkline.ts`), none of it AI-generated. A persistent nav bar
      (`AppNav`) replaces buried inline links with a contextual Overview/
      Study/Tutor/Exam/Review/Progress bar inside each course. The study
      dashboard is now a real "what should I do today" page: a greeting,
      overall-progress bar, study streak, real data-derived notifications
      (due reviews, weakening concepts, an upcoming exam, a study streak),
      a *Today's Plan* time-boxed list built by ranking the Phase 6
      adaptive engine's own candidate actions alongside a Phase 9 review
      item (no second scoring system), a Reviews-due card, and a Weak
      Areas card. A new `/courses/:id/progress` analytics page (stats,
      concept mastery bars, a mastery-over-time sparkline built from real
      `KnowledgeEvidence`, review-outcome history, exam score history) and
      the concept detail page now also show each concept's review count/
      last/next review and accuracy. `ReviewRunner` gained Hint/"I don't
      know" parity with Active Recall by wiring in the *existing*
      hint/reveal endpoints — no new evaluation logic. Fixed real bugs
      found during the audit: a missing `force-dynamic` on the document
      detail page, an unvalidated exam id silently falling through instead
      of 404ing, `ExamGoalForm` swallowing failed requests, and
      `OralExamRunner`'s error state being a dead end with no way back.
- [x] **Phase 11 — Tutor streaming + UX/latency polish.** No changes to the
      `TutorEngine` decision architecture, persistence semantics, or rate
      limiting — Claude's language-generation step for Socratic messages,
      hints, and explanations now streams via the Anthropic SDK's
      `messages.stream()` (`streamText()` in `src/lib/ai/claude.ts`), using
      a plain-text call shape instead of structured JSON extraction since
      streamed structured output only yields partial-JSON deltas, not
      readable text. `POST /api/tutor/sessions/:id/messages` now returns a
      Server-Sent Events `ReadableStream` (`start` / `delta` / `metadata` /
      `complete` / `error`) built on `streamTutorMessage()`, which shares
      its decision/evidence/misconception logic with the unchanged
      non-streaming `submitTutorMessage()` via extracted `prepareTurn()` /
      `finalizeTurn()` helpers. The final `TutorMessage` is still persisted
      exactly once, only after the full reply is accumulated server-side —
      never per-token, never on a failed or cancelled generation. Real
      upstream cancellation propagates an `AbortSignal` through to the
      Anthropic streaming call. `TutorChat.tsx` shows the student's message
      instantly, a streaming placeholder with a cursor that fills in
      incrementally, a Stop button, and Retry on error. Non-AI actions
      (TEACH_BACK, COMPLETE) go straight to `complete` with no fabricated
      streaming. Development-only `[TUTOR_LATENCY]` logging reports
      decision/TTFT/generation/persistence/total timings per turn.
- [x] **Phase 12 — AI cost & token optimization.** No changes to
      `TutorEngine`, the learning architecture, or any evaluation logic —
      every Claude call was audited and now has an explicit, env-configurable
      output-token ceiling (`src/lib/ai/token-budgets.ts`) instead of
      falling through to `extractStructured`/`streamText`'s old unbounded
      default (4096/1024). Pricing is centralized in a single table
      (`src/lib/ai/pricing.ts`'s `calculateAiCost()`) instead of scattered
      constants. The pre-existing `AiUsageLog` model (Phase 3) gained
      `sessionId`/`latencyMs`/`success` columns; `extractStructured` and
      `streamText` now log every call — including failures, not just
      successes — and `src/lib/ai/usage-aggregation.ts` adds reusable cost/
      token queries (by model, by operation, requests/day, most expensive
      operations) for a future admin phase. The Tutor's conversation window
      (already bounded at 6 turns) is now sourced from `AI_CONTEXT_RECENT_
      MESSAGES` instead of a hardcoded constant; sessions longer than
      `AI_CONTEXT_MAX_MESSAGES` get a deterministic (non-AI) summary of the
      turns that fall outside that window instead of silently losing them.
      A short-TTL in-memory dedup cache (`src/lib/ai/cache.ts`) makes an
      identical (session, content) resubmission — double-click, retry,
      streaming reconnect — replay the first attempt's result instead of
      re-running the decision pipeline and paying for a second Claude call;
      only successful turns are cached, so a genuine failure always retries
      for real. Model routing was reviewed call-by-call and left unchanged
      — every operation was already correctly routed to `fast` or
      `default`.
- [x] **Phase 13 — Complete Tutor streaming + safe incremental Markdown.**
      Closed the two remaining non-streaming Tutor generation paths:
      `startTutorSession`'s opening question and the dedicated `/hint`
      endpoint now stream through the exact same `TutorStreamEvent`
      protocol (start/delta/metadata/complete/error) Phase 11 already
      established for normal messages — `prepareTutorSessionStart`/
      `finalizeSessionStart` and `prepareHint`/`finalizeHint` mirror the
      existing `prepareTurn`/`finalizeTurn` split, and `streamText` (Phase
      11) is the only Claude call involved, never a new one. A resumed
      session (nothing to generate) still returns plain JSON, decided by
      the route before any stream opens, never a fabricated stream. Fixed
      a real gap streaming's cancellation support opened up: a session
      whose opening-message generation is aborted before persisting no
      longer gets silently "resumed" empty on the next visit — it's
      detected as orphaned and its opening message is (re)generated
      against the same row. `src/lib/http/sse.ts` consolidates the SSE
      `ReadableStream` mechanics every one of the three streaming routes
      now shares. `TutorChat.tsx` gained an explicit five-state streaming
      state machine (`idle/connecting/streaming/complete/error/cancelled`)
      with a monotonic stream-epoch guard against stale/duplicate
      completions, memoized message bubbles, and scroll-follow that
      respects the reader scrolling up. `src/lib/markdown/safe-markdown.tsx`
      is a small dependency-free Markdown renderer (paragraphs, headings,
      lists, bold/italic, inline code, fenced code blocks, blockquotes,
      links) that renders straight to React elements — never
      `dangerouslySetInnerHTML` — so literal HTML in model output is always
      inert text, and unterminated constructs during streaming fall back to
      plain text instead of crashing or producing malformed markup.
- [x] **Phase 14 — TTS / Voice Tutor.** A purely additive audio layer on top
      of the existing text Tutor — no second Tutor, no change to
      `TutorEngine`/persistence/streaming, and the app works completely
      normally with TTS off (`TTS_ENABLED=false`, the default). A vendor-
      neutral `TTSProvider` interface (`src/lib/tts/provider.ts`) is
      implemented once, via raw `fetch()` (no new SDK dependency, same
      "smallest necessary dependency" precedent as Phase 11/13), by
      `OpenAiTtsProvider`. Synthesis is entirely on-demand:
      `synthesizeTutorMessage()` (`src/lib/tts/tutor-message-tts.ts`) only
      ever runs after a `TutorMessage` has already streamed and persisted
      (Phase 11/13), so TTS can never add latency to the Tutor's text
      response. Authorization is derived from the message's own
      `session.userId` relation — a client never supplies a session id to
      check against. Text sent to the provider is only the message's own
      content, run through a deterministic (non-AI) Markdown-to-speech
      cleaner (`src/lib/tts/text-cleaning.ts`) that strips headings,
      emphasis, code fences, links, citation lines, and list syntax into
      natural spoken sentences. Long responses are split at sentence (and,
      as a fallback, word) boundaries (`src/lib/tts/chunking.ts`) rather
      than silently truncated, with `part`/`totalParts` communicated via
      response headers so the client can auto-chain playback. Generated
      audio is cached in a new `TutorMessageAudio` table, keyed by
      `messageId + voice + model + textHash` — never by `messageId` alone
      — so a changed message can never serve stale audio, and a cache-read
      failure (e.g. a missing file) falls back to regeneration instead of
      failing the request. Audio is stored via a second
      `LocalStorageProvider` instance rooted at `AUDIO_STORAGE_ROOT`
      (`src/lib/storage/audio-storage.ts`), separate from uploaded course
      documents, and the API route (`POST /api/tutor/tts`) returns raw
      audio bytes — never a JSON envelope with a storage path. Cost/usage
      is tracked in a new `TtsUsageLog` table (character-based, not
      token-based) kept deliberately separate from `AiUsageLog`, with
      `src/lib/tts/usage-aggregation.ts` providing the same category of
      reusable summary/breakdown queries Phase 12 built for Claude usage.
      `TutorChat.tsx` gained a simple Play/Pause/Stop control per Tutor
      message, driven by an idle/loading/playing/paused/error state
      machine with a single shared `<audio>` element so starting one
      message's audio always stops any other; state is always conveyed in
      the button's text, never by icon alone, and playback is never
      auto-started. A TTS failure never alters Tutor session state or
      leaves the text response unreadable — the message stays fully
      visible with a small retry affordance.
- [x] **Phase 15 — Study Advisor + Knowledge Hub + PDF export.** Two
      additive layers on top of everything built so far — no parallel
      Tutor, ingestion pipeline, or scoring system.
      **Knowledge Hub:** a new `Folder` model (self-referential
      `parentFolderId` tree, cascading delete with best-effort storage
      cleanup) and `Document.folderId`/`contentHash` give multi-file
      organization and SHA-256 duplicate detection (scoped per course) on
      top of the unchanged Phase 2 ingestion pipeline — `uploadDocument`
      itself never changed shape; a new `uploadDocumentDeduped` wraps it
      for the bulk path. A multi-file upload route processes each file
      independently (`uploadDocumentDeduped` + existing `processDocument`),
      so one bad file never fails the batch. The course page's Documents
      section is now a client `KnowledgeHub` component: folder navigation,
      drag & drop multi-upload with per-file status, bulk move/delete/
      retry, and filename/folder search — replacing the old single-file
      `UploadPdfForm` (deleted, now genuinely dead code).
      **Study Advisor:** decides *what* to study, *when*, and *how much*
      time to allocate — never *how* (every actual learning action still
      routes through the existing Tutor/Active Recall/Exam/Review). Its
      knowledge-gap analysis is not a new scoring formula — it reuses
      Phase 6's `getStudentLearningState()`/`calculateConceptValue()`
      exactly, filtered to a resolved material scope (course/folder/
      documents, traced relationally via a new `StudyRoadmapDocument` join,
      never just a label). A deterministic time-budget calculator
      (`src/lib/advisor/time-budget.ts`) computes available minutes from
      `minutesPerDay`/`studyDays`/deadline entirely in TypeScript; the one
      Claude call (`STUDY_ADVISOR_ROADMAP`, logged to `AiUsageLog` exactly
      like every other call since Phase 12 — no separate tracking
      mechanism needed) only decides prioritization, sequencing, and
      weekly narrative from a compact context (goal, deadline, time
      budget, scope label, ranked priority list — never raw document
      text), and any concept id it returns outside the allowed candidate
      set is dropped before persisting. Per-item `reason` text is composed
      deterministically from the same evidence numbers the adaptive engine
      already computed (`src/lib/advisor/reasons.ts`) — "your recent
      accuracy is 48%" is always a real number, never an AI guess. Weekly/
      daily scheduling is a deterministic round-robin over each week's
      actual study dates, capped at `minutesPerDay`, persisted as
      `StudyRoadmap`/`StudyRoadmapWeek`/`StudyRoadmapItem`. Roadmap pages
      are always DB → render, never DB → AI → render. Progress blends live
      current mastery (dominant signal), item completion, and milestone
      completion — not just a completed/total ratio. Replanning
      (`src/lib/advisor/replan.ts`) re-runs the same deterministic pipeline
      against current state and persists a new version linked via
      `replacesRoadmapId`, archiving (never deleting) the one it replaces;
      completed work naturally deprioritizes itself through the same
      mastery-based scoring, with no special-casing required.
      **PDF export:** `src/lib/pdf/roadmap-pdf.ts` (pdf-lib, moved from
      devDependencies to dependencies) renders a persisted roadmap
      deterministically — no AI call, no fabricated content, never a raw
      database id in the output.
- [x] **Phase 16 — Adaptive Study Advisor intelligence + dynamic
      roadmap.** Upgrades Phase 15's static generator into a system that
      reacts to real learning behavior, without adding a second Tutor,
      spaced-repetition engine, adaptive engine, or knowledge model. A new
      `AdaptationTrigger` enum and `StudyRoadmapStatus.PAUSED` extend the
      existing versioning model; each replan still writes a full new
      `StudyRoadmap` row (a deliberate divergence from the spec's own
      delta-strategy suggestion, documented on the model) but now carries
      `adaptationTrigger`/`adaptationReason`/`changeSummary`/
      `lastEvaluatedAt` metadata, and `version` now increments from the
      roadmap it replaces instead of every row defaulting to 1. Nine new
      `src/lib/advisor/*` modules are almost entirely plain TypeScript
      arithmetic over already-persisted data — `trends.ts` (windowed
      average comparison over `KnowledgeEvidence.score`, ≥4 observations
      before calling a direction), `missed-work.ts` and `urgency.ts`
      (missed minutes/sessions, a days-remaining urgency band, and a hard
      `insufficientTime` capacity check), `adaptive-priority.ts` (multiplies
      Phase 6/15's existing `ConceptValueBreakdown.value` by trend/urgency
      multipliers — never a competing scoring system, and scoped only to
      adaptation decisions, not initial generation), `health.ts` (ON_TRACK/
      AT_RISK/BEHIND/INSUFFICIENT_DATA from expected-vs-actual progress),
      `change-detection.ts` (`checkAdaptationNeeded`, a read-only
      significant-change gate windowed against `lastEvaluatedAt` — a GET
      route never writes), `next-action.ts` (`getNextBestAction`, reusing
      today/overdue roadmap items → Phase 9's `getDueReviews` → Phase 6's
      knowledge-gap ranking, in that priority order, with a Tutor-signal
      override on a low-accuracy incorrect streak), `diff.ts` (a human-
      readable removed/movedEarlier/added summary, never a raw DB diff),
      and `exam-mode.ts` (biases which existing `StudyRoadmapItemAction` an
      item gets as a deadline nears — the Phase 8 Exam Engine itself is
      untouched). `roadmap-service.ts` now carries a replan's already-
      COMPLETED items forward as new rows (`carriedForward: true`) instead
      of leaving them stranded in the archived version, and
      `lifecycle.ts` adds pause/resume (no overdue penalties or
      significant-change checks while paused; resume never auto-replans,
      it only returns a `suggestedAdaptation` the student can act on).
      `replan.ts` gained an options object (trigger/reason/deadline/
      minutesPerDay/studyDays) so deadline and available-time changes reuse
      the exact same pipeline with an explicit trigger rather than mutating
      a roadmap in place. Six new routes
      (`health`/`next-action`/`adaptation-check`/`pause`/`resume`/
      `settings`) stay pure reads or thin wrappers around
      `replanStudyRoadmap`. The roadmap detail page fetches `health` and
      `adaptation` alongside Phase 15's existing DB reads in the same
      `Promise.all` — still DB → render, never DB → AI → render — and
      `RoadmapView` adds a health badge, a "What should I study now?"
      panel, an adaptation-needed banner with a "Review and update my
      plan" CTA, a change-diff panel, and pause/resume buttons, all in
      plain non-technical copy. The only AI call remains the one from
      Phase 15 (`generateRoadmapWithAi`), now split into
      `STUDY_ADVISOR_INITIAL`/`STUDY_ADVISOR_REPLAN` request types so
      Phase 12's existing usage aggregation separates their cost with zero
      new aggregation code.
