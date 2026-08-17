import { z } from "zod";
import { extractStructuredWithRetry } from "@/lib/ai/structured-retry";
import { AI_TIMEOUT_MS } from "@/lib/ai/timeout-budgets";
import type { CandidateConcept, CandidateConceptEvidence } from "./concept-extractor";
import { MAX_SEMANTIC_DUPLICATE_GROUPS } from "./config";

/**
 * Deterministic, always-safe normalization: case, whitespace, and
 * punctuation only. Deliberately does NOT try to collapse abbreviations or
 * synonyms ("TCP" vs "Transmission Control Protocol") — that requires
 * judgment, not string manipulation, and a wrong deterministic merge can't
 * be undone. See mergeSemanticDuplicates for that case.
 */
export function normalizeConceptName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[.,;:!?"'()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface MergedConcept {
  name: string;
  normalizedName: string;
  description: string;
  difficulty: number;
  evidence: CandidateConceptEvidence[];
}

/** Merges candidates whose names are identical after deterministic normalization. */
export function mergeByNormalizedName(candidates: CandidateConcept[]): {
  concepts: MergedConcept[];
  mergedCount: number;
} {
  const byNormalizedName = new Map<string, MergedConcept>();
  let mergedCount = 0;

  for (const candidate of candidates) {
    const normalizedName = normalizeConceptName(candidate.name);
    if (normalizedName.length === 0) {
      continue;
    }

    const existing = byNormalizedName.get(normalizedName);
    if (existing) {
      existing.evidence.push(...candidate.evidence);
      mergedCount += 1;
    } else {
      byNormalizedName.set(normalizedName, {
        name: candidate.name,
        normalizedName,
        description: candidate.description,
        difficulty: candidate.difficulty,
        evidence: [...candidate.evidence],
      });
    }
  }

  return { concepts: [...byNormalizedName.values()], mergedCount };
}

const SemanticDuplicateSchema = z.object({
  duplicateGroups: z
    .array(
      z.object({
        canonicalName: z.string().min(1),
        duplicateNames: z.array(z.string().min(1)).min(1).max(10),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(MAX_SEMANTIC_DUPLICATE_GROUPS),
});

const SEMANTIC_MERGE_SYSTEM = `You are reviewing a list of concept names extracted from a single course to find near-duplicates: different names that refer to the EXACT SAME underlying concept (for example, an abbreviation and its full form, or minor rewording of the identical idea).

Rules:
- Only group names that denote the identical concept. Do NOT group merely related, similar, or overlapping concepts — when in doubt, leave them separate. A missed duplicate is far safer than wrongly merging two distinct concepts.
- canonicalName must be exactly one of the names already listed, and must appear in its own group's duplicateNames or be the clearest form among them.
- Every name should appear in at most one group.
- If there are no duplicates, return an empty duplicateGroups array.
- Give a confidence between 0 and 1 for each group.
- Return structured JSON only, matching the provided schema.`;

/** Best-effort AI pass to find near-duplicate concept names that deterministic normalization can't catch (spec §10, §11). */
export async function findSemanticDuplicateGroups(
  courseTitle: string,
  names: string[],
  options?: { userId?: string | null },
) {
  if (names.length < 2) {
    return { duplicateGroups: [] as z.infer<typeof SemanticDuplicateSchema>["duplicateGroups"] };
  }

  const prompt = `Course: ${courseTitle}\n\nConcept names:\n${names.map((name) => `- ${name}`).join("\n")}\n\nFind groups of names that refer to the exact same concept.`;

  const { data } = await extractStructuredWithRetry(
    {
      model: "fast",
      system: SEMANTIC_MERGE_SYSTEM,
      prompt,
      schema: SemanticDuplicateSchema,
      requestType: "concept_dedup",
      userId: options?.userId,
      timeoutMs: AI_TIMEOUT_MS.KNOWLEDGE_EXTRACTION,
    },
    // A too-large or truncated response is far more likely with many names — retry once more with half the list.
    names.length > 4
      ? (opts) => ({
          ...opts,
          prompt: `Course: ${courseTitle}\n\nConcept names:\n${names.slice(0, Math.ceil(names.length / 2)).map((name) => `- ${name}`).join("\n")}\n\nFind groups of names that refer to the exact same concept.`,
        })
      : undefined,
  );

  return data;
}

export async function mergeSemanticDuplicates(
  courseTitle: string,
  concepts: MergedConcept[],
  threshold: number,
  options?: { userId?: string | null },
): Promise<{ concepts: MergedConcept[]; mergedCount: number; skippedReason?: string }> {
  if (concepts.length < 2) {
    return { concepts, mergedCount: 0 };
  }

  const byName = new Map(concepts.map((concept) => [concept.name, concept]));

  let duplicateGroups: z.infer<typeof SemanticDuplicateSchema>["duplicateGroups"];
  try {
    ({ duplicateGroups } = await findSemanticDuplicateGroups(
      courseTitle,
      concepts.map((concept) => concept.name),
      options,
    ));
  } catch (error) {
    // This pass is explicitly best-effort (see findSemanticDuplicateGroups above) — a failure here
    // (a malformed/too-large model response, a transient AI error, etc.) must never discard the
    // rest of an otherwise-successful knowledge graph build. Fall back to the deterministic merge
    // only, and let the caller decide whether/how to surface that it was skipped.
    console.error(`Semantic duplicate detection failed for course "${courseTitle}", skipping semantic merge:`, error);
    return {
      concepts,
      mergedCount: 0,
      skippedReason: "Could not check for near-duplicate concept names this time; only exact-name matches were merged.",
    };
  }

  const absorbedNames = new Set<string>();
  let mergedCount = 0;

  for (const group of duplicateGroups) {
    if (group.confidence < threshold) {
      continue;
    }
    const canonical = byName.get(group.canonicalName);
    if (!canonical || absorbedNames.has(group.canonicalName)) {
      continue;
    }

    for (const duplicateName of group.duplicateNames) {
      if (duplicateName === group.canonicalName) {
        continue;
      }
      const duplicate = byName.get(duplicateName);
      if (!duplicate || absorbedNames.has(duplicateName)) {
        continue;
      }

      canonical.evidence.push(...duplicate.evidence);
      absorbedNames.add(duplicateName);
      mergedCount += 1;
    }
  }

  return {
    concepts: concepts.filter((concept) => !absorbedNames.has(concept.name)),
    mergedCount,
  };
}
