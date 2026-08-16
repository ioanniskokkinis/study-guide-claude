-- CreateEnum
CREATE TYPE "AdaptationTrigger" AS ENUM ('INITIAL_GENERATION', 'MISSED_SESSIONS', 'LOW_PERFORMANCE', 'DEADLINE_CHANGE', 'KNOWLEDGE_CHANGE', 'MANUAL_REPLAN', 'TIME_AVAILABILITY_CHANGE');

-- AlterEnum
ALTER TYPE "StudyRoadmapStatus" ADD VALUE 'PAUSED';

-- AlterTable
ALTER TABLE "study_roadmap_items" ADD COLUMN     "carriedForward" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "study_roadmaps" ADD COLUMN     "adaptationReason" TEXT,
ADD COLUMN     "adaptationTrigger" "AdaptationTrigger" NOT NULL DEFAULT 'INITIAL_GENERATION',
ADD COLUMN     "changeSummary" JSONB,
ADD COLUMN     "lastEvaluatedAt" TIMESTAMP(3);
