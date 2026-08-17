import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { AI_TIMEOUT_MS } from "@/lib/ai/timeout-budgets";
import { generateHint, evaluateStudentResponse } from "@/lib/tutor/tutor-evaluator";
import { gradeExamAnswer } from "@/lib/exam/exam-evaluator";
import { generateRoadmapWithAi } from "@/lib/advisor/roadmap-generator";

/**
 * Phase 19 §19.7 regression: before this phase, 18 of 19 distinct Claude
 * call sites had no `timeoutMs` at all — a hung upstream request had no
 * application-level bound. This doesn't re-test the timeout *mechanism*
 * itself (tests/ai/pricing-and-usage.test.ts already covers extractStructured's
 * real AbortController behavior end-to-end) — it just proves a representative
 * sample of call sites across modules actually wire a `timeoutMs` through,
 * so a future refactor that accidentally drops the field is caught here
 * rather than only surfacing as a production hang.
 */
describe("AI call sites forward an explicit timeoutMs (Phase 19 §19.7)", () => {
  function mockOnce(data: unknown) {
    vi.mocked(extractStructured).mockResolvedValueOnce({ data, usage: { inputTokens: 1, outputTokens: 1 } });
  }

  it("tutor-evaluator.generateHint uses AI_TIMEOUT_MS.HINT", async () => {
    mockOnce({ message: "A hint." });
    await generateHint({
      conceptName: "Photosynthesis",
      conceptDescription: null,
      masteryBucket: "developing",
      recentMistakeDescriptions: [],
      conversationHistory: [],
      level: 1,
      tutorPrompt: "What converts light into energy?",
    });
    expect(extractStructured).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: AI_TIMEOUT_MS.HINT }));
  });

  it("tutor-evaluator.evaluateStudentResponse uses AI_TIMEOUT_MS.EVALUATION", async () => {
    mockOnce({
      classification: "CORRECT",
      correctness: 1,
      completeness: 1,
      misconceptionDetected: false,
      misconceptionDescription: null,
      feedback: "Nice.",
    });
    await evaluateStudentResponse({
      conceptName: "Photosynthesis",
      conceptDescription: null,
      masteryBucket: "developing",
      recentMistakeDescriptions: [],
      conversationHistory: [],
      tutorPrompt: "What converts light into energy?",
      studentResponse: "Chlorophyll.",
    });
    expect(extractStructured).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: AI_TIMEOUT_MS.EVALUATION }));
  });

  it("exam-evaluator.gradeExamAnswer uses AI_TIMEOUT_MS.EVALUATION", async () => {
    mockOnce({
      classification: "CORRECT",
      criteria: { correctness: 1, completeness: 1, reasoning: 1, application: 1, conceptualUnderstanding: 1 },
      missingConcepts: [],
      misconceptions: [],
      severity: null,
      feedback: "Nice.",
    });
    await gradeExamAnswer(
      {
        conceptName: "Photosynthesis",
        questionPrompt: "Explain it.",
        questionType: "OPEN_ENDED",
        expectedAnswer: null,
        rubric: [],
        sourceChunks: [],
        studentAnswer: "Chlorophyll converts light to energy.",
      },
      "user-1",
    );
    expect(extractStructured).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: AI_TIMEOUT_MS.EVALUATION }));
  });

  it("roadmap-generator.generateRoadmapWithAi uses AI_TIMEOUT_MS.STUDY_ADVISOR", async () => {
    mockOnce({
      summary: "A plan.",
      priorities: [],
      weeks: [],
      milestones: [],
      recommendations: [],
      risks: [],
    });
    await generateRoadmapWithAi({
      input: {
        courseTitle: "Biology",
        goal: "Pass the final",
        targetScore: null,
        deadline: null,
        scopeLabel: "Entire course",
        minutesPerDay: 30,
        totalStudyDays: 20,
        totalMinutes: 600,
        numberOfWeeks: 4,
        overallMasteryPercent: 40,
        weakConceptCount: 1,
        developingConceptCount: 1,
        strongConceptCount: 0,
        unknownConceptCount: 0,
        priorities: [],
      },
      allowedConceptIds: new Set(),
      userId: "user-1",
      courseId: "course-1",
      requestType: "STUDY_ADVISOR_INITIAL",
    });
    expect(extractStructured).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: AI_TIMEOUT_MS.STUDY_ADVISOR }));
  });
});
