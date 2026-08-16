-- CreateTable
CREATE TABLE "tts_usage_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "messageId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "characterCount" INTEGER NOT NULL,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
    "latencyMs" INTEGER,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tts_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_message_audio" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "characterCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_message_audio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tts_usage_logs_userId_idx" ON "tts_usage_logs"("userId");

-- CreateIndex
CREATE INDEX "tts_usage_logs_sessionId_idx" ON "tts_usage_logs"("sessionId");

-- CreateIndex
CREATE INDEX "tts_usage_logs_messageId_idx" ON "tts_usage_logs"("messageId");

-- CreateIndex
CREATE INDEX "tts_usage_logs_createdAt_idx" ON "tts_usage_logs"("createdAt");

-- CreateIndex
CREATE INDEX "tutor_message_audio_messageId_idx" ON "tutor_message_audio"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "tutor_message_audio_messageId_voice_model_textHash_key" ON "tutor_message_audio"("messageId", "voice", "model", "textHash");

-- AddForeignKey
ALTER TABLE "tts_usage_logs" ADD CONSTRAINT "tts_usage_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_message_audio" ADD CONSTRAINT "tutor_message_audio_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "tutor_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
