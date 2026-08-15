-- Phase 9: spaced repetition. Replaces the unused Phase 1 `reviews` stub
-- (never referenced by any business logic) with a real persistent schedule
-- (ReviewItem) plus an append-only history table (ReviewEvent).

-- DropForeignKey (old Phase 1 stub)
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_conceptId_fkey";
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_userId_fkey";

-- DropTable (old Phase 1 stub — no live data depends on it)
DROP TABLE "reviews";

-- DropEnum (old Phase 1 stub values — recreated below with the Phase 9 values)
DROP TYPE "ReviewOutcome";

-- CreateEnum
CREATE TYPE "ReviewItemStatus" AS ENUM ('NEW', 'LEARNING', 'REVIEW', 'RELEARNING');

-- CreateEnum
CREATE TYPE "ReviewOutcome" AS ENUM ('AGAIN', 'HARD', 'GOOD', 'EASY');

-- CreateEnum
CREATE TYPE "ReviewEventSource" AS ENUM ('REVIEW_SESSION');

-- AlterEnum
ALTER TYPE "StudySessionMode" ADD VALUE 'REVIEW';

-- CreateTable
CREATE TABLE "review_items" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "status" "ReviewItemStatus" NOT NULL DEFAULT 'NEW',
    "interval" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "difficulty" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "repetitionCount" INTEGER NOT NULL DEFAULT 0,
    "lapseCount" INTEGER NOT NULL DEFAULT 0,
    "lastReviewedAt" TIMESTAMP(3),
    "nextReviewAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_items_interval_check" CHECK ("interval" >= 0),
    CONSTRAINT "review_items_stability_check" CHECK ("stability" >= 0),
    CONSTRAINT "review_items_difficulty_check" CHECK ("difficulty" >= 1 AND "difficulty" <= 5),
    CONSTRAINT "review_items_repetitionCount_check" CHECK ("repetitionCount" >= 0),
    CONSTRAINT "review_items_lapseCount_check" CHECK ("lapseCount" >= 0)
);

-- CreateTable
CREATE TABLE "review_events" (
    "id" TEXT NOT NULL,
    "reviewItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "outcome" "ReviewOutcome" NOT NULL,
    "previousInterval" DOUBLE PRECISION NOT NULL,
    "newInterval" DOUBLE PRECISION NOT NULL,
    "source" "ReviewEventSource" NOT NULL DEFAULT 'REVIEW_SESSION',
    "attemptId" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_events_previousInterval_check" CHECK ("previousInterval" >= 0),
    CONSTRAINT "review_events_newInterval_check" CHECK ("newInterval" >= 0)
);

-- CreateIndex
CREATE INDEX "review_items_userId_nextReviewAt_idx" ON "review_items"("userId", "nextReviewAt");

-- CreateIndex
CREATE INDEX "review_items_userId_conceptId_idx" ON "review_items"("userId", "conceptId");

-- CreateIndex
CREATE INDEX "review_items_courseId_idx" ON "review_items"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "review_items_userId_conceptId_key" ON "review_items"("userId", "conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "review_events_attemptId_key" ON "review_events"("attemptId");

-- CreateIndex
CREATE INDEX "review_events_reviewItemId_idx" ON "review_events"("reviewItemId");

-- CreateIndex
CREATE INDEX "review_events_userId_reviewedAt_idx" ON "review_events"("userId", "reviewedAt");

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_reviewItemId_fkey" FOREIGN KEY ("reviewItemId") REFERENCES "review_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "learning_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
