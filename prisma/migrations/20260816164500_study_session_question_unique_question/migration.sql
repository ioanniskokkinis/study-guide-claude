-- CreateIndex
CREATE UNIQUE INDEX "study_session_questions_sessionId_questionId_key" ON "study_session_questions"("sessionId", "questionId");
