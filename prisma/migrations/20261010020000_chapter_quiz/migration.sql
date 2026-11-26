-- CreateTable
CREATE TABLE "ChapterQuiz" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" TEXT[],
    "correctIndex" INTEGER NOT NULL,
    "explanation" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChapterQuiz_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChapterQuiz_documentId_order_idx" ON "ChapterQuiz"("documentId", "order");

-- AddForeignKey
ALTER TABLE "ChapterQuiz" ADD CONSTRAINT "ChapterQuiz_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChapterQuiz" ADD CONSTRAINT "ChapterQuiz_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
