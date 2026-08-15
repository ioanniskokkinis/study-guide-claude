/** Mirrors the Prisma `ReviewOutcome` enum — kept here (spec §4, matching the Phase 5/7/8 const-array convention) as the one place API routes validate a client-supplied outcome against. */
export const REVIEW_OUTCOMES = ["AGAIN", "HARD", "GOOD", "EASY"] as const;
export type ReviewOutcomeValue = (typeof REVIEW_OUTCOMES)[number];
