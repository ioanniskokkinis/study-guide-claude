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
- [ ] **Phase 9 — Spaced repetition.** Review scheduling.
- [ ] **Phase 10 — Polish.** Dashboard, progress charts, UX, performance,
      tests, error handling.
