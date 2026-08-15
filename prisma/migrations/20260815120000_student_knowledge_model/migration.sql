-- CreateEnum
CREATE TYPE "EvidenceSourceType" AS ENUM ('QUESTION', 'TEACH_BACK', 'SCENARIO', 'EXAM', 'DIAGNOSTIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "EvidenceOutcome" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILURE');

-- CreateEnum
CREATE TYPE "LearningActivityType" AS ENUM ('RECALL', 'EXPLANATION', 'APPLICATION', 'TRANSFER', 'TEACH_BACK', 'SCENARIO', 'EXAM', 'DIAGNOSTIC');

-- CreateEnum
CREATE TYPE "StudentMistakeCategory" AS ENUM ('FACTUAL_ERROR', 'CONCEPTUAL_GAP', 'MISCONCEPTION', 'PREREQUISITE_GAP', 'REASONING_ERROR', 'INCOMPLETE_ANSWER', 'APPLICATION_FAILURE', 'TRANSFER_FAILURE', 'TERMINOLOGY_CONFUSION', 'CARELESS_ERROR');

-- CreateEnum
CREATE TYPE "MistakeSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- AlterEnum
BEGIN;
CREATE TYPE "MasteryStatus_new" AS ENUM ('UNKNOWN', 'LEARNING', 'DEVELOPING', 'STRONG', 'MASTERED', 'NEEDS_REMEDIATION');
ALTER TABLE "public"."student_concept_mastery" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "student_concept_mastery" ALTER COLUMN "status" TYPE "MasteryStatus_new" USING ("status"::text::"MasteryStatus_new");
ALTER TYPE "MasteryStatus" RENAME TO "MasteryStatus_old";
ALTER TYPE "MasteryStatus_new" RENAME TO "MasteryStatus";
DROP TYPE "public"."MasteryStatus_old";
ALTER TABLE "student_concept_mastery" ALTER COLUMN "status" SET DEFAULT 'UNKNOWN';
COMMIT;

-- DropForeignKey
ALTER TABLE "mistakes" DROP CONSTRAINT "mistakes_answerId_fkey";

-- DropForeignKey
ALTER TABLE "mistakes" DROP CONSTRAINT "mistakes_conceptId_fkey";

-- DropForeignKey
ALTER TABLE "mistakes" DROP CONSTRAINT "mistakes_userId_fkey";

-- AlterTable
ALTER TABLE "student_concept_mastery" DROP COLUMN "lastReviewedAt",
DROP COLUMN "nextReviewAt",
ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hintCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastFailureAt" TIMESTAMP(3),
ADD COLUMN     "lastSuccessAt" TIMESTAMP(3),
ADD COLUMN     "revealCount" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "status" SET DEFAULT 'UNKNOWN';

-- DropTable
DROP TABLE "mistakes";

-- DropEnum
DROP TYPE "MistakeCategory";

-- CreateTable
CREATE TABLE "knowledge_evidence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "sourceType" "EvidenceSourceType" NOT NULL,
    "sourceId" TEXT,
    "outcome" "EvidenceOutcome" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "activityType" "LearningActivityType" NOT NULL,
    "difficulty" INTEGER NOT NULL DEFAULT 1,
    "score" DOUBLE PRECISION,
    "correctness" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "usedHint" BOOLEAN NOT NULL DEFAULT false,
    "revealedAnswer" BOOLEAN NOT NULL DEFAULT false,
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_mistakes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "attemptId" TEXT,
    "category" "StudentMistakeCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "MistakeSeverity" NOT NULL DEFAULT 'MEDIUM',
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_mistakes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_evidence_userId_idx" ON "knowledge_evidence"("userId");

-- CreateIndex
CREATE INDEX "knowledge_evidence_conceptId_idx" ON "knowledge_evidence"("conceptId");

-- CreateIndex
CREATE INDEX "knowledge_evidence_createdAt_idx" ON "knowledge_evidence"("createdAt");

-- CreateIndex
CREATE INDEX "learning_attempts_userId_idx" ON "learning_attempts"("userId");

-- CreateIndex
CREATE INDEX "learning_attempts_conceptId_idx" ON "learning_attempts"("conceptId");

-- CreateIndex
CREATE INDEX "learning_attempts_createdAt_idx" ON "learning_attempts"("createdAt");

-- CreateIndex
CREATE INDEX "student_mistakes_userId_idx" ON "student_mistakes"("userId");

-- CreateIndex
CREATE INDEX "student_mistakes_conceptId_idx" ON "student_mistakes"("conceptId");

-- CreateIndex
CREATE INDEX "student_mistakes_resolved_idx" ON "student_mistakes"("resolved");

-- CreateIndex
CREATE INDEX "student_concept_mastery_status_idx" ON "student_concept_mastery"("status");

-- AddForeignKey
ALTER TABLE "knowledge_evidence" ADD CONSTRAINT "knowledge_evidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_evidence" ADD CONSTRAINT "knowledge_evidence_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_attempts" ADD CONSTRAINT "learning_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_attempts" ADD CONSTRAINT "learning_attempts_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "learning_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Data integrity (spec §25): DB-level CHECK constraints as a backstop
-- underneath the application-layer validation in mastery-engine.ts /
-- record-outcome.ts. Prisma's schema DSL has no native CHECK support, so
-- these are hand-appended raw SQL.

ALTER TABLE "student_concept_mastery"
  ADD CONSTRAINT "student_concept_mastery_scores_range" CHECK (
    "recallScore" BETWEEN 0 AND 1 AND
    "explanationScore" BETWEEN 0 AND 1 AND
    "applicationScore" BETWEEN 0 AND 1 AND
    "transferScore" BETWEEN 0 AND 1 AND
    "confidenceScore" BETWEEN 0 AND 1 AND
    "overallMastery" BETWEEN 0 AND 1
  ),
  ADD CONSTRAINT "student_concept_mastery_counts_nonnegative" CHECK (
    "exposureCount" >= 0 AND
    "attemptCount" >= 0 AND
    "successCount" >= 0 AND
    "failureCount" >= 0 AND
    "hintCount" >= 0 AND
    "revealCount" >= 0
  );

ALTER TABLE "knowledge_evidence"
  ADD CONSTRAINT "knowledge_evidence_score_range" CHECK ("score" BETWEEN 0 AND 1),
  ADD CONSTRAINT "knowledge_evidence_confidence_range" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1);

ALTER TABLE "learning_attempts"
  ADD CONSTRAINT "learning_attempts_score_range" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 1),
  ADD CONSTRAINT "learning_attempts_correctness_range" CHECK ("correctness" IS NULL OR "correctness" BETWEEN 0 AND 1),
  ADD CONSTRAINT "learning_attempts_confidence_range" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "learning_attempts_difficulty_positive" CHECK ("difficulty" >= 1),
  ADD CONSTRAINT "learning_attempts_duration_nonnegative" CHECK ("durationSeconds" IS NULL OR "durationSeconds" >= 0);
