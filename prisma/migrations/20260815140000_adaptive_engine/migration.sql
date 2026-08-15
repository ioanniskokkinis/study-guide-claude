-- CreateEnum
CREATE TYPE "LearningGoalType" AS ENUM ('EXAM', 'MASTER_COURSE', 'CERTIFICATION', 'GENERAL');

-- CreateEnum
CREATE TYPE "AdaptiveActionType" AS ENUM ('ACTIVE_RECALL', 'REMEDIATION', 'PREREQUISITE_REVIEW', 'REVIEW', 'CHALLENGE', 'REST');

-- CreateEnum
CREATE TYPE "AdaptiveReasonType" AS ENUM ('PREREQUISITE_GAP', 'RECENT_MISTAKE', 'MISCONCEPTION', 'REPEATED_FAILURE', 'FORGETTING_RISK', 'WEAKNESS', 'GOAL_RELEVANCE', 'SUCCESS_STREAK', 'NO_DATA', 'GENERAL');

-- CreateTable
CREATE TABLE "learning_goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "type" "LearningGoalType" NOT NULL,
    "targetDate" TIMESTAMP(3),
    "targetConceptIds" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adaptive_decision_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "actionType" "AdaptiveActionType" NOT NULL,
    "priority" DOUBLE PRECISION NOT NULL,
    "reasonType" "AdaptiveReasonType" NOT NULL,
    "reasonMessage" TEXT NOT NULL,
    "accepted" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adaptive_decision_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learning_goals_userId_courseId_idx" ON "learning_goals"("userId", "courseId");

-- CreateIndex
CREATE INDEX "adaptive_decision_logs_userId_courseId_idx" ON "adaptive_decision_logs"("userId", "courseId");

-- CreateIndex
CREATE INDEX "adaptive_decision_logs_createdAt_idx" ON "adaptive_decision_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adaptive_decision_logs" ADD CONSTRAINT "adaptive_decision_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adaptive_decision_logs" ADD CONSTRAINT "adaptive_decision_logs_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adaptive_decision_logs" ADD CONSTRAINT "adaptive_decision_logs_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data integrity (spec §25 precedent) — backstop under app-layer validation.
ALTER TABLE "learning_goals"
  ADD CONSTRAINT "learning_goals_priority_positive" CHECK ("priority" >= 1);

ALTER TABLE "adaptive_decision_logs"
  ADD CONSTRAINT "adaptive_decision_logs_priority_range" CHECK ("priority" BETWEEN 0 AND 1);
