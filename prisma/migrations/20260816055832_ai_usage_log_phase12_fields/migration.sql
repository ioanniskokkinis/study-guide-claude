-- AlterTable
ALTER TABLE "ai_usage_logs" ADD COLUMN     "latencyMs" INTEGER,
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "success" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "ai_usage_logs_sessionId_idx" ON "ai_usage_logs"("sessionId");

-- CreateIndex
CREATE INDEX "ai_usage_logs_requestType_idx" ON "ai_usage_logs"("requestType");
