/**
 * Tunable knobs for the knowledge extraction pipeline, kept in one place
 * rather than hardcoded into UI components or scattered across the
 * pipeline (spec §15, §25).
 */

/** How many document chunks go into a single concept-extraction request. */
export const CHUNKS_PER_CONCEPT_EXTRACTION_BATCH = 6;

/**
 * Safety cap on how many concepts go into a single relationship/prerequisite
 * extraction request. Concept summaries are compact (name + short
 * description + a couple of evidence snippets), so a typical course fits in
 * one batch; this only kicks in for unusually large courses. Known
 * limitation: relationships between concepts split across different batches
 * are not found.
 */
export const MAX_CONCEPTS_PER_RELATIONSHIP_BATCH = 60;

/** How many evidence snippets from a concept's sources are shown to the relationship/prerequisite passes. */
export const EVIDENCE_SNIPPETS_PER_CONCEPT = 2;

export const RELATIONSHIP_CONFIDENCE = {
  /** >= this: accepted automatically. */
  autoAccept: 0.85,
  /** >= this and < autoAccept: accepted but flagged needsReview. Below this: rejected. */
  reviewFloor: 0.6,
};

/** How confident the semantic-duplicate pass must be before two concept names are merged. */
export const CONCEPT_MERGE_CONFIDENCE_THRESHOLD = 0.9;

/**
 * Safety cap on how many duplicate-name groups the semantic-duplicate pass
 * may return in one response. Must stay generous relative to course size —
 * a large course (many documents, many chunks) can legitimately produce
 * well over a small cap's worth of genuine near-duplicate concept names,
 * and a response that merely exceeds the cap is not a sign of anything
 * wrong with the extraction itself.
 */
export const MAX_SEMANTIC_DUPLICATE_GROUPS = 150;
