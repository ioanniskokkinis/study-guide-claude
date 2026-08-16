-- CreateEnum
CREATE TYPE "AnswerEvaluationStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'TIMEOUT');

-- AlterTable
ALTER TABLE "answers" ADD COLUMN     "evaluationStatus" "AnswerEvaluationStatus" NOT NULL DEFAULT 'PENDING';

-- Backfill: existing rows already have enough signal to classify correctly
-- (a fresh DEFAULT 'PENDING' would otherwise mislabel already-evaluated
-- history as still awaiting evaluation).
UPDATE "answers" SET "evaluationStatus" = 'COMPLETED' WHERE "correctness" IS NOT NULL;
UPDATE "answers" SET "evaluationStatus" = 'FAILED' WHERE "correctness" IS NULL AND "evaluationError" IS NOT NULL;
