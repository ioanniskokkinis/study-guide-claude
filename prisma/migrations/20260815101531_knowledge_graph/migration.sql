-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('NOT_STARTED', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "RelationshipType" AS ENUM ('prerequisite', 'contains', 'related', 'example_of', 'contrasts_with', 'causes', 'part_of', 'applies_to');

-- DropForeignKey
ALTER TABLE "prerequisites" DROP CONSTRAINT "prerequisites_dependentConceptId_fkey";

-- DropForeignKey
ALTER TABLE "prerequisites" DROP CONSTRAINT "prerequisites_prerequisiteConceptId_fkey";

-- AlterTable
ALTER TABLE "concepts" DROP COLUMN "sourceReferences",
ADD COLUMN     "normalizedName" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "knowledgeBuiltAt" TIMESTAMP(3),
ADD COLUMN     "knowledgeError" TEXT,
ADD COLUMN     "knowledgeStatus" "KnowledgeStatus" NOT NULL DEFAULT 'NOT_STARTED';

-- DropTable
DROP TABLE "prerequisites";

-- CreateTable
CREATE TABLE "concept_sources" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "documentChunkId" TEXT NOT NULL,
    "relevance" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "evidence" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concept_relationships" (
    "id" TEXT NOT NULL,
    "sourceConceptId" TEXT NOT NULL,
    "targetConceptId" TEXT NOT NULL,
    "relationshipType" "RelationshipType" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" TEXT NOT NULL,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "concept_sources_conceptId_idx" ON "concept_sources"("conceptId");

-- CreateIndex
CREATE INDEX "concept_sources_documentChunkId_idx" ON "concept_sources"("documentChunkId");

-- CreateIndex
CREATE UNIQUE INDEX "concept_sources_conceptId_documentChunkId_key" ON "concept_sources"("conceptId", "documentChunkId");

-- CreateIndex
CREATE INDEX "concept_relationships_sourceConceptId_idx" ON "concept_relationships"("sourceConceptId");

-- CreateIndex
CREATE INDEX "concept_relationships_targetConceptId_idx" ON "concept_relationships"("targetConceptId");

-- CreateIndex
CREATE INDEX "concept_relationships_relationshipType_idx" ON "concept_relationships"("relationshipType");

-- CreateIndex
CREATE UNIQUE INDEX "concept_relationships_sourceConceptId_targetConceptId_relat_key" ON "concept_relationships"("sourceConceptId", "targetConceptId", "relationshipType");

-- CreateIndex
CREATE UNIQUE INDEX "concepts_courseId_normalizedName_key" ON "concepts"("courseId", "normalizedName");

-- AddForeignKey
ALTER TABLE "concept_sources" ADD CONSTRAINT "concept_sources_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_sources" ADD CONSTRAINT "concept_sources_documentChunkId_fkey" FOREIGN KEY ("documentChunkId") REFERENCES "document_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_relationships" ADD CONSTRAINT "concept_relationships_sourceConceptId_fkey" FOREIGN KEY ("sourceConceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_relationships" ADD CONSTRAINT "concept_relationships_targetConceptId_fkey" FOREIGN KEY ("targetConceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

