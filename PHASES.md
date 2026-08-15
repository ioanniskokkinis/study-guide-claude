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
