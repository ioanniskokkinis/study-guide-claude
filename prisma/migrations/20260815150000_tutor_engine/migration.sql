-- CreateEnum
CREATE TYPE "TutorMode" AS ENUM ('SOCRATIC', 'TEACH_BACK', 'REMEDIATION');

-- CreateEnum
CREATE TYPE "TutorSessionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "TutorDecisionAction" AS ENUM ('ASK_QUESTION', 'ASK_FOLLOWUP', 'GIVE_HINT', 'GIVE_EXPLANATION', 'SIMPLIFY', 'DEEPEN', 'CHECK_PREREQUISITE', 'REMEDIATE', 'TEACH_BACK', 'INCREASE_DIFFICULTY', 'DECREASE_DIFFICULTY', 'COMPLETE');

-- CreateEnum
CREATE TYPE "TutorMessageRole" AS ENUM ('TUTOR', 'STUDENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TutorMessageType" AS ENUM ('QUESTION', 'FOLLOWUP', 'HINT', 'EXPLANATION', 'FEEDBACK', 'TEACH_BACK_PROMPT', 'REMEDIATION', 'COMPLETION');

-- CreateTable
CREATE TABLE "tutor_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "mode" "TutorMode" NOT NULL DEFAULT 'SOCRATIC',
    "status" "TutorSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentStep" "TutorDecisionAction",
    "socraticDepth" INTEGER NOT NULL DEFAULT 0,
    "hintLevel" INTEGER NOT NULL DEFAULT 0,
    "difficulty" INTEGER NOT NULL DEFAULT 1,
    "consecutiveCorrect" INTEGER NOT NULL DEFAULT 0,
    "questionsAnswered" INTEGER NOT NULL DEFAULT 0,
    "hintsUsedTotal" INTEGER NOT NULL DEFAULT 0,
    "answerRevealed" BOOLEAN NOT NULL DEFAULT false,
    "lastExplanationStrategy" TEXT,
    "aiCallCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tutor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "TutorMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "messageType" "TutorMessageType" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_misconceptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "MistakeSeverity" NOT NULL DEFAULT 'MEDIUM',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "correctSinceCount" INTEGER NOT NULL DEFAULT 0,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "student_misconceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_session_outcomes" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "masteryDelta" DOUBLE PRECISION,
    "misconceptionResolved" BOOLEAN NOT NULL DEFAULT false,
    "hintsUsed" INTEGER NOT NULL DEFAULT 0,
    "questionsAnswered" INTEGER NOT NULL DEFAULT 0,
    "teachBackScore" DOUBLE PRECISION,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_session_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tutor_sessions_userId_courseId_idx" ON "tutor_sessions"("userId", "courseId");

-- CreateIndex
CREATE INDEX "tutor_sessions_userId_status_idx" ON "tutor_sessions"("userId", "status");

-- CreateIndex
CREATE INDEX "tutor_messages_sessionId_idx" ON "tutor_messages"("sessionId");

-- CreateIndex
CREATE INDEX "student_misconceptions_userId_conceptId_idx" ON "student_misconceptions"("userId", "conceptId");

-- CreateIndex
CREATE INDEX "student_misconceptions_resolved_idx" ON "student_misconceptions"("resolved");

-- CreateIndex
CREATE UNIQUE INDEX "tutor_session_outcomes_sessionId_key" ON "tutor_session_outcomes"("sessionId");

-- AddForeignKey
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_messages" ADD CONSTRAINT "tutor_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "tutor_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_misconceptions" ADD CONSTRAINT "student_misconceptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_misconceptions" ADD CONSTRAINT "student_misconceptions_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_session_outcomes" ADD CONSTRAINT "tutor_session_outcomes_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "tutor_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_session_outcomes" ADD CONSTRAINT "tutor_session_outcomes_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-authored CHECK constraints (not expressible in schema.prisma) --------

ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_socratic_depth_range" CHECK ("socraticDepth" BETWEEN 0 AND 4);
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_hint_level_range" CHECK ("hintLevel" BETWEEN 0 AND 4);
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "tutor_sessions_difficulty_range" CHECK ("difficulty" BETWEEN 1 AND 5);
ALTER TABLE "student_misconceptions" ADD CONSTRAINT "student_misconceptions_confidence_range" CHECK ("confidence" BETWEEN 0 AND 1);
ALTER TABLE "tutor_session_outcomes" ADD CONSTRAINT "tutor_session_outcomes_teach_back_score_range" CHECK ("teachBackScore" IS NULL OR "teachBackScore" BETWEEN 0 AND 1);

