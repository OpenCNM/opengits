-- CreateTable
CREATE TABLE IF NOT EXISTS "RepoSemanticGraph" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "gitSha" TEXT NOT NULL,
    "payload" BYTEA NOT NULL,
    "symbolCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepoSemanticGraph_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RepoSemanticGraph_owner_repo_idx" ON "RepoSemanticGraph"("owner", "repo");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RepoSemanticGraph_owner_repo_gitSha_key" ON "RepoSemanticGraph"("owner", "repo", "gitSha");
