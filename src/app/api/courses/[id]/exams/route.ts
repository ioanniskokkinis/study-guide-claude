import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { createExam, examErrorStatus, listExamHistory, toStudentFacingQuestion } from "@/lib/exam/exam-orchestrator";
import { EXAM_MODES, type ExamConfig, type ExamModeValue } from "@/lib/exam/types";
import { DEFAULT_DURATION_MINUTES, DEFAULT_PASSING_SCORE, DEFAULT_QUESTION_COUNT } from "@/lib/exam/config";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface CreateExamBody {
  mode?: string;
  questionCount?: number;
  durationMinutes?: number;
  difficulty?: number | "ADAPTIVE";
  allowHints?: boolean;
  allowSources?: boolean;
  passingScore?: number;
  targetConceptIds?: string[];
  coverage?: ExamConfig["coverage"];
}

function isExamMode(value: unknown): value is ExamModeValue {
  return typeof value === "string" && (EXAM_MODES as readonly string[]).includes(value);
}

/** Real, persisted exam history for this course (spec §48-49). */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();
  const history = await listExamHistory(user.id, courseId);
  return NextResponse.json({ exams: history });
}

/** Creates a new exam from an ExamConfig (spec §4) — blueprint + questions are generated synchronously (WRITTEN/SCENARIO pre-generate the full set; ADAPTIVE only the opening question; ORAL none yet). */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:exam-create`, { maxRequests: 5, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: CreateExamBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const mode = isExamMode(body.mode) ? body.mode : "WRITTEN";
  const difficulty: number | "ADAPTIVE" = body.difficulty === "ADAPTIVE" ? "ADAPTIVE" : typeof body.difficulty === "number" ? body.difficulty : 2;

  const config: ExamConfig = {
    courseId,
    userId: user.id,
    mode,
    questionCount: typeof body.questionCount === "number" && body.questionCount > 0 ? body.questionCount : DEFAULT_QUESTION_COUNT,
    durationMinutes: typeof body.durationMinutes === "number" && body.durationMinutes > 0 ? body.durationMinutes : DEFAULT_DURATION_MINUTES,
    difficulty,
    allowHints: body.allowHints ?? false,
    allowSources: body.allowSources ?? false,
    passingScore: typeof body.passingScore === "number" ? body.passingScore : DEFAULT_PASSING_SCORE,
    targetConceptIds: body.targetConceptIds,
    coverage: body.coverage,
  };

  try {
    const exam = await createExam(config);
    return NextResponse.json(
      { exam: { ...exam, questions: exam.questions.map(toStudentFacingQuestion) } },
      { status: 201 },
    );
  } catch (error) {
    const { status, message } = examErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
