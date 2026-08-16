-- AlterEnum
ALTER TYPE "KnowledgeStatus" ADD VALUE 'QUEUED';

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "knowledgeProgress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "knowledgeStage" TEXT,
ADD COLUMN     "knowledgeStageMessage" TEXT,
ADD COLUMN     "knowledgeStartedAt" TIMESTAMP(3);
