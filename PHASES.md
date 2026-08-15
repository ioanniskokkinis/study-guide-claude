# Build phases

Tracking implementation against the MVP phase plan. Build order matters —
each phase depends on the previous one's persisted data model.

- [x] **Phase 1 — Foundation.** Next.js + TypeScript + Tailwind scaffold,
      PostgreSQL + Prisma (driver adapters) + pgvector, full domain schema
      migrated, environment configuration, `/api/health`, minimal status
      page, Vitest harness.
- [ ] **Phase 2 — Course ingestion.** Create course, upload PDF, extract
      text, store document, chunk document, source references.
- [ ] **Phase 3 — Knowledge graph.** Concept extraction, prerequisite
      extraction, concept graph, concept pages.
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
