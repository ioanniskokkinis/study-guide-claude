-- CreateEnum
CREATE TYPE "StudyRoadmapScopeType" AS ENUM ('COURSE', 'FOLDER', 'DOCUMENTS');

-- CreateEnum
CREATE TYPE "StudyRoadmapStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "StudyRoadmapItemAction" AS ENUM ('LEARN', 'REVIEW', 'PRACTICE', 'ACTIVE_RECALL', 'SPACED_REPETITION', 'TUTOR', 'EXAM_PRACTICE');

-- CreateEnum
CREATE TYPE "StudyRoadmapItemStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED');

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "folderId" TEXT;

-- CreateTable
CREATE TABLE "folders" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "parentFolderId" TEXT,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_roadmaps" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "targetScore" DOUBLE PRECISION,
    "deadline" TIMESTAMP(3),
    "minutesPerDay" INTEGER NOT NULL,
    "studyDays" JSONB NOT NULL,
    "status" "StudyRoadmapStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopeType" "StudyRoadmapScopeType" NOT NULL,
    "scopeFolderId" TEXT,
    "summary" TEXT NOT NULL,
    "risks" JSONB NOT NULL,
    "recommendations" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "replacesRoadmapId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_roadmaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_roadmap_documents" (
    "id" TEXT NOT NULL,
    "roadmapId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,

    CONSTRAINT "study_roadmap_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_roadmap_weeks" (
    "id" TEXT NOT NULL,
    "roadmapId" TEXT NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "focusSummary" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "estimatedMinutes" INTEGER NOT NULL,

    CONSTRAINT "study_roadmap_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_roadmap_items" (
    "id" TEXT NOT NULL,
    "roadmapId" TEXT NOT NULL,
    "weekId" TEXT,
    "conceptId" TEXT,
    "action" "StudyRoadmapItemAction" NOT NULL,
    "title" TEXT NOT NULL,
    "estimatedMinutes" INTEGER NOT NULL,
    "priority" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "scheduledDate" TIMESTAMP(3),
    "status" "StudyRoadmapItemStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "isMilestone" BOOLEAN NOT NULL DEFAULT false,
    "baselineMastery" DOUBLE PRECISION,
    "sourceDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_roadmap_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "folders_courseId_idx" ON "folders"("courseId");

-- CreateIndex
CREATE INDEX "folders_parentFolderId_idx" ON "folders"("parentFolderId");

-- CreateIndex
CREATE UNIQUE INDEX "study_roadmaps_replacesRoadmapId_key" ON "study_roadmaps"("replacesRoadmapId");

-- CreateIndex
CREATE INDEX "study_roadmaps_userId_courseId_idx" ON "study_roadmaps"("userId", "courseId");

-- CreateIndex
CREATE INDEX "study_roadmaps_userId_status_idx" ON "study_roadmaps"("userId", "status");

-- CreateIndex
CREATE INDEX "study_roadmap_documents_roadmapId_idx" ON "study_roadmap_documents"("roadmapId");

-- CreateIndex
CREATE UNIQUE INDEX "study_roadmap_documents_roadmapId_documentId_key" ON "study_roadmap_documents"("roadmapId", "documentId");

-- CreateIndex
CREATE INDEX "study_roadmap_weeks_roadmapId_idx" ON "study_roadmap_weeks"("roadmapId");

-- CreateIndex
CREATE UNIQUE INDEX "study_roadmap_weeks_roadmapId_weekNumber_key" ON "study_roadmap_weeks"("roadmapId", "weekNumber");

-- CreateIndex
CREATE INDEX "study_roadmap_items_roadmapId_idx" ON "study_roadmap_items"("roadmapId");

-- CreateIndex
CREATE INDEX "study_roadmap_items_weekId_idx" ON "study_roadmap_items"("weekId");

-- CreateIndex
CREATE INDEX "study_roadmap_items_roadmapId_scheduledDate_idx" ON "study_roadmap_items"("roadmapId", "scheduledDate");

-- CreateIndex
CREATE INDEX "study_roadmap_items_conceptId_idx" ON "study_roadmap_items"("conceptId");

-- CreateIndex
CREATE INDEX "documents_folderId_idx" ON "documents"("folderId");

-- CreateIndex
CREATE INDEX "documents_courseId_contentHash_idx" ON "documents"("courseId", "contentHash");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parentFolderId_fkey" FOREIGN KEY ("parentFolderId") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmaps" ADD CONSTRAINT "study_roadmaps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmaps" ADD CONSTRAINT "study_roadmaps_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmaps" ADD CONSTRAINT "study_roadmaps_scopeFolderId_fkey" FOREIGN KEY ("scopeFolderId") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmaps" ADD CONSTRAINT "study_roadmaps_replacesRoadmapId_fkey" FOREIGN KEY ("replacesRoadmapId") REFERENCES "study_roadmaps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmap_documents" ADD CONSTRAINT "study_roadmap_documents_roadmapId_fkey" FOREIGN KEY ("roadmapId") REFERENCES "study_roadmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmap_documents" ADD CONSTRAINT "study_roadmap_documents_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmap_weeks" ADD CONSTRAINT "study_roadmap_weeks_roadmapId_fkey" FOREIGN KEY ("roadmapId") REFERENCES "study_roadmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmap_items" ADD CONSTRAINT "study_roadmap_items_roadmapId_fkey" FOREIGN KEY ("roadmapId") REFERENCES "study_roadmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmap_items" ADD CONSTRAINT "study_roadmap_items_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "study_roadmap_weeks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmap_items" ADD CONSTRAINT "study_roadmap_items_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_roadmap_items" ADD CONSTRAINT "study_roadmap_items_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
