import type { Prisma } from "@/generated/prisma/client";

/**
 * ScenarioExamEngine (spec §32-34). Scenario questions share the same
 * generation pipeline as every other exam question type (exam-generator.ts
 * with `forceScenario: true`) and the same rubric-based grading path as
 * open-ended answers (exam-grader.ts's gradeFromRubric via
 * exam-evaluator.ts's gradeExamAnswer) — this module only shapes the
 * scenario's structured context (spec §33) for both the UI and the grading
 * prompt, rather than duplicating either concern.
 */

export interface ScenarioContext {
  context: string;
  objective: string;
  constraints: string[];
  availableInformation: string[];
}

/** Reads the ExamQuestion.scenario JSON column back into a typed shape — never trusts its structure blindly. */
export function parseScenario(scenario: Prisma.JsonValue | null): ScenarioContext | null {
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) return null;
  const s = scenario as Record<string, unknown>;
  if (typeof s.context !== "string" || typeof s.objective !== "string") return null;

  return {
    context: s.context,
    objective: s.objective,
    constraints: Array.isArray(s.constraints) ? s.constraints.filter((c): c is string => typeof c === "string") : [],
    availableInformation: Array.isArray(s.availableInformation)
      ? s.availableInformation.filter((c): c is string => typeof c === "string")
      : [],
  };
}
