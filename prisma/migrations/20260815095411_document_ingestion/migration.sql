-- AlterEnum
BEGIN;
CREATE TYPE "ProcessingStatus_new" AS ENUM ('UPLOADED', 'PROCESSING', 'READY', 'FAILED');
ALTER TABLE "public"."documents" ALTER COLUMN "processingStatus" DROP DEFAULT;
ALTER TABLE "documents" ALTER COLUMN "processingStatus" TYPE "ProcessingStatus_new" USING ("processingStatus"::text::"ProcessingStatus_new");
ALTER TYPE "ProcessingStatus" RENAME TO "ProcessingStatus_old";
ALTER TYPE "ProcessingStatus_new" RENAME TO "ProcessingStatus";
DROP TYPE "public"."ProcessingStatus_old";
ALTER TABLE "documents" ALTER COLUMN "processingStatus" SET DEFAULT 'UPLOADED';
COMMIT;

-- AlterTable
ALTER TABLE "document_chunks" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "tokenCount" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "fileSize" INTEGER NOT NULL,
ADD COLUMN     "mimeType" TEXT NOT NULL,
ADD COLUMN     "originalFilename" TEXT NOT NULL,
ADD COLUMN     "pageCount" INTEGER,
ADD COLUMN     "processingError" TEXT,
ALTER COLUMN "processingStatus" SET DEFAULT 'UPLOADED';

