-- CreateEnum
CREATE TYPE "StudySessionMode" AS ENUM ('ACTIVE_RECALL');

-- CreateEnum
CREATE TYPE "StudySessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');

-- AlterEnum
BEGIN;
CREATE TYPE "QuestionType_new" AS ENUM ('RECALL', 'EXPLAIN', 'COMPARE', 'APPLY', 'TRANSFER');
ALTER TABLE "questions" ALTER COLUMN "type" TYPE "QuestionType_new" USING ("type"::text::"QuestionType_new");
ALTER TYPE "QuestionType" RENAME TO "QuestionType_old";
ALTER TYPE "QuestionType_new" RENAME TO "QuestionType";
DROP TYPE "public"."QuestionType_old";
COMMIT;

-- AlterTable
ALTER TABLE "answers" DROP COLUMN "detectedMisconceptions",
DROP COLUMN "missingConcepts",
ADD COLUMN     "attemptId" TEXT,
ADD COLUMN     "correctAnswer" TEXT,
ADD COLUMN     "durationSeconds" INTEGER,
ADD COLUMN     "errors" JSONB,
ADD COLUMN     "evaluationError" TEXT,
ADD COLUMN     "misconceptions" JSONB,
ADD COLUMN     "missingPoints" JSONB,
ADD COLUMN     "needsRemediation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "prerequisiteGapConceptId" TEXT,
ADD COLUMN     "revealedAnswer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sessionQuestionId" TEXT,
ADD COLUMN     "strengths" JSONB,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "usedHint" BOOLEAN NOT NULL DEFAULT false,
DROP COLUMN "correctness",
ADD COLUMN     "correctness" "EvidenceOutcome";

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "courseId" TEXT NOT NULL,
ADD COLUMN     "normalizedPrompt" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "study_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "mode" "StudySessionMode" NOT NULL DEFAULT 'ACTIVE_RECALL',
    "status" "StudySessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "targetLength" INTEGER NOT NULL,
    "questionsAnswered" INTEGER NOT NULL DEFAULT 0,
    "questionsCorrect" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_session_questions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "presentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "attemptId" TEXT,
    "hintsUsed" INTEGER NOT NULL DEFAULT 0,
    "revealed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_session_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "study_sessions_userId_idx" ON "study_sessions"("userId");

-- CreateIndex
CREATE INDEX "study_sessions_courseId_idx" ON "study_sessions"("courseId");

-- CreateIndex
CREATE INDEX "study_sessions_userId_status_idx" ON "study_sessions"("userId", "status");

-- CreateIndex
CREATE INDEX "study_session_questions_sessionId_idx" ON "study_session_questions"("sessionId");

-- CreateIndex
CREATE INDEX "study_session_questions_questionId_idx" ON "study_session_questions"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "study_session_questions_sessionId_position_key" ON "study_session_questions"("sessionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "answers_sessionQuestionId_key" ON "answers"("sessionQuestionId");

-- CreateIndex
CREATE INDEX "questions_courseId_idx" ON "questions"("courseId");

-- CreateIndex
CREATE INDEX "questions_conceptId_normalizedPrompt_idx" ON "questions"("conceptId", "normalizedPrompt");

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_sessionQuestionId_fkey" FOREIGN KEY ("sessionQuestionId") REFERENCES "study_session_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "learning_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_session_questions" ADD CONSTRAINT "study_session_questions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "study_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_session_questions" ADD CONSTRAINT "study_session_questions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_session_questions" ADD CONSTRAINT "study_session_questions_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "learning_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Data integrity (spec §25 precedent from Phase 4, extended to Phase 5's
-- new score/confidence-bearing columns): DB-level CHECK constraints as a
-- backstop underneath application-layer validation.

ALTER TABLE "answers"
  ADD CONSTRAINT "answers_score_range" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 1),
  ADD CONSTRAINT "answers_confidence_range" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "answers_reasoning_quality_range" CHECK ("reasoningQuality" IS NULL OR "reasoningQuality" BETWEEN 0 AND 1),
  ADD CONSTRAINT "answers_completeness_range" CHECK ("completeness" IS NULL OR "completeness" BETWEEN 0 AND 1),
  ADD CONSTRAINT "answers_duration_nonnegative" CHECK ("durationSeconds" IS NULL OR "durationSeconds" >= 0);

ALTER TABLE "questions"
  ADD CONSTRAINT "questions_difficulty_range" CHECK ("difficulty" BETWEEN 1 AND 5);

ALTER TABLE "study_sessions"
  ADD CONSTRAINT "study_sessions_target_length_positive" CHECK ("targetLength" >= 1),
  ADD CONSTRAINT "study_sessions_questions_answered_nonnegative" CHECK ("questionsAnswered" >= 0),
  ADD CONSTRAINT "study_sessions_questions_correct_nonnegative" CHECK ("questionsCorrect" >= 0 AND "questionsCorrect" <= "questionsAnswered");

ALTER TABLE "study_session_questions"
  ADD CONSTRAINT "study_session_questions_position_positive" CHECK ("position" >= 1),
  ADD CONSTRAINT "study_session_questions_hints_nonnegative" CHECK ("hintsUsed" >= 0);
