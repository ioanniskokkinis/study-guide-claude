-- CreateEnum
CREATE TYPE "ExamMode" AS ENUM ('WRITTEN', 'ORAL', 'SCENARIO', 'ADAPTIVE');

-- CreateEnum
CREATE TYPE "ExamStatus" AS ENUM ('CREATED', 'ACTIVE', 'PAUSED', 'SUBMITTED', 'GRADED', 'EXPIRED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ExamDifficultyMode" AS ENUM ('FIXED', 'ADAPTIVE');

-- CreateEnum
CREATE TYPE "ExamQuestionType" AS ENUM ('MULTIPLE_CHOICE', 'MULTI_SELECT', 'TRUE_FALSE', 'SHORT_ANSWER', 'OPEN_ENDED', 'PROBLEM_SOLVING', 'SCENARIO', 'TEACH_BACK');

-- CreateEnum
CREATE TYPE "CognitiveLevel" AS ENUM ('RECALL', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE');

-- CreateEnum
CREATE TYPE "ExamAnswerClassification" AS ENUM ('CORRECT', 'PARTIALLY_CORRECT', 'INCORRECT', 'MISCONCEPTION', 'UNANSWERED');

-- CreateEnum
CREATE TYPE "ExamMistakeCategory" AS ENUM ('KNOWLEDGE_GAP', 'MISCONCEPTION', 'RECALL_FAILURE', 'REASONING_FAILURE', 'APPLICATION_FAILURE', 'PREREQUISITE_FAILURE', 'CARELESS_ERROR', 'INCOMPLETE_ANSWER', 'TIME_PRESSURE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ExamConfidenceLevel" AS ENUM ('CONFIDENT', 'UNSURE', 'GUESSING');

-- CreateTable
CREATE TABLE "exams" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "mode" "ExamMode" NOT NULL,
    "status" "ExamStatus" NOT NULL DEFAULT 'CREATED',
    "difficultyMode" "ExamDifficultyMode" NOT NULL DEFAULT 'FIXED',
    "difficulty" INTEGER NOT NULL DEFAULT 2,
    "questionCount" INTEGER NOT NULL,
    "timeLimitSeconds" INTEGER,
    "passingScore" DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    "allowHints" BOOLEAN NOT NULL DEFAULT false,
    "allowSources" BOOLEAN NOT NULL DEFAULT false,
    "targetConceptIds" JSONB,
    "blueprint" JSONB,
    "isRetest" BOOLEAN NOT NULL DEFAULT false,
    "currentQuestionIndex" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_questions" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "questionType" "ExamQuestionType" NOT NULL,
    "cognitiveLevel" "CognitiveLevel" NOT NULL,
    "difficulty" INTEGER NOT NULL DEFAULT 2,
    "position" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" JSONB,
    "correctOptionIds" JSONB,
    "expectedAnswer" TEXT,
    "rubric" JSONB,
    "sourceReferences" JSONB,
    "prerequisiteConceptIds" JSONB,
    "learningObjective" TEXT,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "scenario" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_answers" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "answerText" TEXT,
    "selectedOptionIds" JSONB,
    "confidence" "ExamConfidenceLevel",
    "timeSpentSeconds" INTEGER NOT NULL DEFAULT 0,
    "hintsUsed" INTEGER NOT NULL DEFAULT 0,
    "revealedAnswer" BOOLEAN NOT NULL DEFAULT false,
    "oralDepth" INTEGER,
    "classification" "ExamAnswerClassification",
    "score" DOUBLE PRECISION,
    "criteriaScores" JSONB,
    "feedback" TEXT,
    "missingConcepts" JSONB,
    "mistakeCategory" "ExamMistakeCategory",
    "mistakeSeverity" "MistakeSeverity",
    "attemptId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exam_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_results" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "totalQuestions" INTEGER NOT NULL,
    "correctAnswers" INTEGER NOT NULL,
    "partialAnswers" INTEGER NOT NULL,
    "incorrectAnswers" INTEGER NOT NULL,
    "unanswered" INTEGER NOT NULL,
    "timeSpentSeconds" INTEGER NOT NULL,
    "conceptScores" JSONB NOT NULL,
    "cognitiveScores" JSONB NOT NULL,
    "mistakeSummary" JSONB NOT NULL,
    "readinessScore" DOUBLE PRECISION,
    "gradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exams_userId_courseId_idx" ON "exams"("userId", "courseId");

-- CreateIndex
CREATE INDEX "exams_userId_status_idx" ON "exams"("userId", "status");

-- CreateIndex
CREATE INDEX "exam_questions_examId_idx" ON "exam_questions"("examId");

-- CreateIndex
CREATE INDEX "exam_questions_conceptId_idx" ON "exam_questions"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "exam_answers_questionId_key" ON "exam_answers"("questionId");

-- CreateIndex
CREATE INDEX "exam_answers_examId_idx" ON "exam_answers"("examId");

-- CreateIndex
CREATE INDEX "exam_answers_userId_idx" ON "exam_answers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "exam_results_examId_key" ON "exam_results"("examId");

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_examId_fkey" FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_answers" ADD CONSTRAINT "exam_answers_examId_fkey" FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_answers" ADD CONSTRAINT "exam_answers_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "exam_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_answers" ADD CONSTRAINT "exam_answers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_answers" ADD CONSTRAINT "exam_answers_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "learning_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_examId_fkey" FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-authored CHECK constraints (not expressible in schema.prisma) --------

ALTER TABLE "exams" ADD CONSTRAINT "exams_difficulty_range" CHECK ("difficulty" BETWEEN 1 AND 5);
ALTER TABLE "exams" ADD CONSTRAINT "exams_passing_score_range" CHECK ("passingScore" BETWEEN 0 AND 1);
ALTER TABLE "exams" ADD CONSTRAINT "exams_question_count_positive" CHECK ("questionCount" > 0);
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_difficulty_range" CHECK ("difficulty" BETWEEN 1 AND 5);
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_points_positive" CHECK ("points" > 0);
ALTER TABLE "exam_answers" ADD CONSTRAINT "exam_answers_score_range" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 1);
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_percentage_range" CHECK ("percentage" BETWEEN 0 AND 1);
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_readiness_range" CHECK ("readinessScore" IS NULL OR "readinessScore" BETWEEN 0 AND 1);

