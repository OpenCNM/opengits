-- 章节多版本竞争制（接力 v2）：ChapterVersion + ChapterVersionVote
-- 注：DocumentChunk.searchVector 等 Prisma 表达不了的伴生 DDL 由
-- reconcile_companion_ddl / migrate:fts 脚本族维护，不在此处触碰。
CREATE TABLE "ChapterVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'RELAY',
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "voteCount" INTEGER NOT NULL DEFAULT 0,
    "isCanonical" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChapterVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChapterVersionVote" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChapterVersionVote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChapterVersion_documentId_visibility_idx" ON "ChapterVersion"("documentId", "visibility");
CREATE INDEX "ChapterVersion_authorId_idx" ON "ChapterVersion"("authorId");
CREATE UNIQUE INDEX "ChapterVersionVote_versionId_userId_key" ON "ChapterVersionVote"("versionId", "userId");

ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "DocumentContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChapterVersionVote" ADD CONSTRAINT "ChapterVersionVote_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ChapterVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChapterVersionVote" ADD CONSTRAINT "ChapterVersionVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
