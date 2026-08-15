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
- [ ] **Phase 4 — Student model.** Mastery, attempts, mistakes, confidence,
      history.
- [ ] **Phase 5 — Active recall.** Question generation, answer submission,
      evaluation, mastery update, next-question selection.
- [ ] **Phase 6 — Adaptive engine.** Difficulty adjustment, prerequisite
      remediation, weak-concept prioritization, "What should I study now?".
- [ ] **Phase 7 — Socratic + teach-back.**
- [ ] **Phase 8 — Exams.** Diagnostic, written exam, exam simulation.
- [ ] **Phase 9 — Spaced repetition.** Review scheduling.
- [ ] **Phase 10 — Polish.** Dashboard, progress charts, UX, performance,
      tests, error handling.
