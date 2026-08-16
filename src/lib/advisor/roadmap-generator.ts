import { extractStructured } from "@/lib/ai/claude";
import { AI_MAX_TOKENS } from "@/lib/ai/token-budgets";
import { env } from "@/lib/env";
import {
  buildStudyAdvisorPrompt,
  StudyAdvisorAiOutputSchema,
  type AdvisorPromptInput,
  type StudyAdvisorAiOutput,
} from "@/lib/ai/prompts/study-advisor";

export interface GenerateRoadmapParams {
  input: AdvisorPromptInput;
  /** The exact concept ids the AI was shown — anything else it returns is dropped, never persisted (spec §28: "never blindly trust model output"). */
  allowedConceptIds: Set<string>;
  userId: string;
  courseId: string;
}

/**
 * The single AI call in the Study Advisor pipeline (Phase 15 §27-28) —
 * everything before this (scope resolution, knowledge-gap analysis, time
 * budgeting) is deterministic, and everything after this (persistence,
 * daily-plan scheduling, progress, PDF export) is deterministic too. Usage
 * is logged to AiUsageLog automatically by extractStructured, exactly like
 * every other Claude call in this codebase (Phase 12) — no separate
 * tracking mechanism.
 */
export async function generateRoadmapWithAi(params: GenerateRoadmapParams): Promise<StudyAdvisorAiOutput> {
  const { system, prompt } = buildStudyAdvisorPrompt(params.input);

  const { data } = await extractStructured({
    model: env.AI_MODEL_STUDY_ADVISOR,
    system,
    prompt,
    schema: StudyAdvisorAiOutputSchema,
    maxTokens: AI_MAX_TOKENS.STUDY_ADVISOR,
    effort: "medium",
    requestType: "STUDY_ADVISOR_ROADMAP",
    userId: params.userId,
    sessionId: params.courseId,
  });

  return {
    ...data,
    priorities: data.priorities.filter((p) => params.allowedConceptIds.has(p.conceptId)),
    weeks: data.weeks.map((w) => ({
      ...w,
      focusConceptIds: w.focusConceptIds.filter((id) => params.allowedConceptIds.has(id)),
    })),
  };
}
