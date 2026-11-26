-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Extensions required by trigram GIN indexes (gin_trgm_ops)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UNPROCESSED', 'PROCESSING', 'PROCESSED', 'ERROR');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'MAINTAINER', 'AUDITOR');

-- CreateEnum
CREATE TYPE "TagKind" AS ENUM ('CATEGORY', 'TAG');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "refresh_token_expires_in" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditBalance" INTEGER NOT NULL DEFAULT 0,
    "signupGiftAt" TIMESTAMP(3),
    "preferredLang1" TEXT,
    "preferredLang2" TEXT,
    "preferredLang3" TEXT,
    "industry" TEXT,
    "primaryProgLang" TEXT,
    "secondaryProgLang" TEXT,
    "fontSize" TEXT NOT NULL DEFAULT 'small',
    "hasPreferencesSet" BOOLEAN NOT NULL DEFAULT false,
    "disabledMcpRepoIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pinnedRepoIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "tier" TEXT NOT NULL DEFAULT 'FREE',
    "mcpRpmLimit" INTEGER NOT NULL DEFAULT 30,
    "dailyMcpQuota" INTEGER NOT NULL DEFAULT 100,
    "singleCallTokenCap" INTEGER NOT NULL DEFAULT 4000,
    "role" TEXT NOT NULL DEFAULT 'USER',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserReadingProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "lastReadPath" TEXT,
    "completedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserReadingProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "edition" TEXT NOT NULL DEFAULT '',
    "semVerLabel" TEXT,
    "skeleton" TEXT,
    "skeletonHash" TEXT,
    "sourceClusterKey" TEXT,
    "navTree" JSONB,
    "repoProfile" JSONB,
    "gitSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "publishGiftAt" TIMESTAMP(3),
    "relayNotifiedAt" TIMESTAMP(3),
    "transcriptionCreditsEarned" INTEGER NOT NULL DEFAULT 0,
    "shelfFeeOverride" INTEGER,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "views" INTEGER NOT NULL DEFAULT 0,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "starCount" INTEGER NOT NULL DEFAULT 0,
    "mcpCallCount" INTEGER NOT NULL DEFAULT 0,
    "mcpStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reviewStatus" TEXT NOT NULL DEFAULT 'NONE',
    "reviewPipeline" JSONB,
    "reviewLlm" JSONB,
    "reviewAutoApproved" BOOLEAN NOT NULL DEFAULT false,
    "rejectionReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "relayEnabled" BOOLEAN NOT NULL DEFAULT false,
    "transcriptionPaused" BOOLEAN NOT NULL DEFAULT false,
    "bestUsedFor" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hasUpstreamUpdate" BOOLEAN NOT NULL DEFAULT false,
    "upstreamCheckedAt" TIMESTAMP(3),
    "upstreamEtag" TEXT,
    "autoSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pendingSyncSha" TEXT,
    "autoSwapCount" INTEGER NOT NULL DEFAULT 0,
    "qualityHold" BOOLEAN NOT NULL DEFAULT false,
    "helpfulCount" INTEGER NOT NULL DEFAULT 0,
    "transcriptionModels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "transcriptionTokens" INTEGER NOT NULL DEFAULT 0,
    "unpublishCooldownUntil" TIMESTAMP(3),
    "unpublishRequestedAt" TIMESTAMP(3),

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpfulVote" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpfulVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedRepo" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "autoFollow" BOOLEAN NOT NULL DEFAULT true,
    "paidCredits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedRepo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FavoriteRepo" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoriteRepo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChapterUpdateJob" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "fromSha" TEXT NOT NULL,
    "toSha" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'UPDATE',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "claimedBy" TEXT,
    "claimedUntil" TIMESTAMP(3),
    "stagedContentId" TEXT,
    "stagedModel" TEXT,
    "frozenCredits" INTEGER NOT NULL DEFAULT 0,
    "baseCredits" INTEGER NOT NULL DEFAULT 0,
    "actualCredits" INTEGER,
    "voteDeadline" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChapterUpdateJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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
    "pinnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChapterVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChapterVersionVote" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChapterVersionVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentReport" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "triage" JSONB,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportUpdateRun" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromSha" TEXT NOT NULL,
    "toSha" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNING',
    "plan" JSONB,
    "candidateSet" JSONB,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ImportUpdateRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "edition" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "params" JSONB NOT NULL,
    "options" JSONB,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchedulerLease" (
    "key" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulerLease_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ImportJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "path" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UNPROCESSED',
    "errorMessage" TEXT,
    "gitSha" TEXT,
    "summary" TEXT,
    "generationModel" TEXT,
    "generationLevel" TEXT,
    "contentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentContent" (
    "id" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "requestFingerprint" TEXT,
    "content" TEXT,
    "lang" TEXT NOT NULL DEFAULT '',
    "generationModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptionJob" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "checkpointFingerprint" TEXT DEFAULT '',
    "options" JSONB,
    "checkpointChunks" JSONB,
    "checkpointTotal" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformBudgetConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "perUserDailyTokens" INTEGER NOT NULL DEFAULT 200000,
    "platformDailyTokens" INTEGER NOT NULL DEFAULT 5000000,
    "breakerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sourceQuotas" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformBudgetConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformCreditsConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "defaultDailyCredits" INTEGER NOT NULL DEFAULT 1000,
    "resetIntervalHours" INTEGER NOT NULL DEFAULT 24,
    "maxCreditsPerImport" INTEGER NOT NULL DEFAULT 300,
    "codePedagogyMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "standardChunkCharSize" INTEGER NOT NULL DEFAULT 1500,
    "publishGiftEnabled" BOOLEAN NOT NULL DEFAULT false,
    "shelfFeeMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "contributionVestingDays" INTEGER NOT NULL DEFAULT 30,
    "initialPublishRewardRatio" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformCreditsConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformReviewConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "apiKeyEncrypted" TEXT NOT NULL DEFAULT '',
    "pipelinePassThreshold" INTEGER NOT NULL DEFAULT 70,
    "llmPassThreshold" INTEGER NOT NULL DEFAULT 75,
    "confidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "enforceQualityGate" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformReviewConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditGrantLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "repositoryId" TEXT,
    "path" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditGrantLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingCreditGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'IMPORT_CONTRIBUTION',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "unlockAt" TIMESTAMP(3) NOT NULL,
    "unlockedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingCreditGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubQuotaLog" (
    "id" BIGSERIAL NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "remaining" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3),
    "endpointClass" TEXT NOT NULL DEFAULT 'api-core',
    "status" INTEGER NOT NULL DEFAULT 200,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubQuotaLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "contentId" TEXT,
    "heading" TEXT,
    "headingPath" TEXT,
    "semVerLabel" TEXT,
    "contentType" TEXT NOT NULL DEFAULT 'prose',
    "content" TEXT NOT NULL,
    "order" INTEGER,
    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((COALESCE(heading, ''::text) || ' '::text) || COALESCE(content, ''::text)))) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "toolInvocations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpisodicEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "targetId" TEXT,
    "duration" INTEGER,
    "metadata" JSONB,
    "repositoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodicEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "userId" TEXT,
    "repositoryId" TEXT,
    "fingerprint" TEXT,
    "severity" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenUsageLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "conversationId" TEXT,
    "messageId" TEXT,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'unknown',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'chat',
    "keyOrigin" TEXT NOT NULL DEFAULT 'platform',
    "purpose" TEXT,
    "promptVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpBundle" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "slug" TEXT NOT NULL,
    "badge" TEXT DEFAULT '❖ 官方精选',
    "isPinned" BOOLEAN NOT NULL DEFAULT true,
    "isStarterPack" BOOLEAN NOT NULL DEFAULT false,
    "starterCategory" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "AdminRole" NOT NULL DEFAULT 'MAINTAINER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detailsJson" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayPolicyConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "emergencyReadOnly" BOOLEAN NOT NULL DEFAULT false,
    "webApiRpm" INTEGER NOT NULL DEFAULT 120,
    "scannerBlockEnabled" BOOLEAN NOT NULL DEFAULT true,
    "blockEmptyUserAgent" BOOLEAN NOT NULL DEFAULT false,
    "transcriptionConcurrency" INTEGER,
    "transcriptionChunkConcurrency" INTEGER,
    "llmUserConcurrency" INTEGER,
    "llmInteractiveHeadroom" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayPolicyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayBlockedIp" (
    "ipAddress" TEXT NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayBlockedIp_pkey" PRIMARY KEY ("ipAddress")
);

-- CreateTable
CREATE TABLE "GatewaySecurityEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ipAddress" TEXT,
    "path" TEXT NOT NULL,
    "userAgent" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewaySecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DissectionCache" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "mermaidCode" TEXT NOT NULL,
    "language" TEXT,
    "tierUsed" INTEGER NOT NULL DEFAULT 1,
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DissectionCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformPromotion" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "targetUrl" TEXT,
    "badge" TEXT NOT NULL DEFAULT '🔥 热门推荐',
    "isPinned" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'promotion',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "dismissible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalMcpToolPolicy" (
    "id" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "tokenBudget" INTEGER NOT NULL DEFAULT 4000,
    "customDescription" TEXT,
    "tierRequirement" TEXT NOT NULL DEFAULT 'FREE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalMcpToolPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagRegistry" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "kind" "TagKind" NOT NULL DEFAULT 'TAG',
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'seed',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TagRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOpenDoc" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL DEFAULT 'OpenGits MCP 网关开放文档',
    "markdown" TEXT NOT NULL,
    "changelog" TEXT,
    "authorEmail" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOpenDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorialConceptNode" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "documentId" TEXT,
    "chunkId" TEXT,
    "headingPath" TEXT,
    "conceptName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "canonicalKey" TEXT,
    "canonicalName" TEXT,
    "category" TEXT NOT NULL DEFAULT 'architecture',
    "principlesText" TEXT,
    "authorReflections" TEXT,
    "sopSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "subTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "globalConceptId" TEXT,

    CONSTRAINT "TutorialConceptNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalConcept" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalConcept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorialConceptEdge" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'related',
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "source" TEXT NOT NULL DEFAULT 'cooccurrence',
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TutorialConceptEdge_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "SystemPrompt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "currentVer" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "promptSchema" JSONB NOT NULL,
    "modelConfig" JSONB,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpActiveSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientVer" TEXT,
    "ipAddress" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "McpActiveSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "encryptedToken" TEXT,
    "prefix" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpCallLog" (
    "id" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "userId" TEXT,
    "clientName" TEXT,
    "repositoryId" TEXT,
    "bundleId" TEXT,
    "dimension" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "responseTimeMs" INTEGER NOT NULL DEFAULT 0,
    "requestedEdition" TEXT,
    "resolvedEdition" TEXT,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpUsageLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "mcpCalls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpUsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorialOutline" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'tutorial',
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TutorialOutline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutlinePart" (
    "id" TEXT NOT NULL,
    "outlineId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "teachingOrder" INTEGER NOT NULL,

    CONSTRAINT "OutlinePart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutlineChapter" (
    "id" TEXT NOT NULL,
    "outlineId" TEXT NOT NULL,
    "partId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "chapterType" TEXT NOT NULL DEFAULT 'mixed',
    "moduleName" TEXT,
    "teachingOrder" INTEGER NOT NULL,

    CONSTRAINT "OutlineChapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutlineNode" (
    "id" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "documentId" TEXT,
    "headingPath" TEXT,
    "title" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL DEFAULT 'doc',
    "teachingOrder" INTEGER NOT NULL,

    CONSTRAINT "OutlineNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalModelProvider" (
    "id" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "badgeLabel" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiFormat" TEXT NOT NULL DEFAULT 'openai',
    "defaultModel" TEXT NOT NULL,
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalModelProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserModelProvider" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "apiFormat" TEXT NOT NULL DEFAULT 'openai',
    "models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "selectedModel" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "latencyMs" INTEGER,
    "lastError" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserModelProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAuthCode" (
    "code" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAuthCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "DaemonTaskRun" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DaemonTaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepoSemanticGraph" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "gitSha" TEXT NOT NULL,
    "payload" BYTEA NOT NULL,
    "symbolCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepoSemanticGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_BundleRepositories" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BundleRepositories_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_expires_idx" ON "Session"("expires");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserReadingProgress_userId_repositoryId_key" ON "UserReadingProgress"("userId", "repositoryId");

-- CreateIndex
CREATE INDEX "Repository_owner_repo_branch_idx" ON "Repository"("owner", "repo", "branch");

-- CreateIndex
CREATE INDEX "Repository_sourceClusterKey_idx" ON "Repository"("sourceClusterKey");

-- CreateIndex
CREATE INDEX "Repository_skeletonHash_idx" ON "Repository"("skeletonHash");

-- CreateIndex
CREATE INDEX "idx_repo_skeleton_trgm" ON "Repository" USING GIN ("skeleton" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Repository_isPublic_views_createdAt_idx" ON "Repository"("isPublic", "views" DESC, "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Repository_isPublic_createdAt_idx" ON "Repository"("isPublic", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Repository_owner_repo_branch_edition_key" ON "Repository"("owner", "repo", "branch", "edition");

-- CreateIndex
CREATE UNIQUE INDEX "HelpfulVote_repositoryId_userId_key" ON "HelpfulVote"("repositoryId", "userId");

-- CreateIndex
CREATE INDEX "SavedRepo_repositoryId_idx" ON "SavedRepo"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedRepo_userId_repositoryId_key" ON "SavedRepo"("userId", "repositoryId");

-- CreateIndex
CREATE INDEX "FavoriteRepo_repositoryId_idx" ON "FavoriteRepo"("repositoryId");

-- CreateIndex
CREATE INDEX "FavoriteRepo_userId_createdAt_idx" ON "FavoriteRepo"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FavoriteRepo_userId_repositoryId_key" ON "FavoriteRepo"("userId", "repositoryId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "ChapterUpdateJob_repositoryId_status_idx" ON "ChapterUpdateJob"("repositoryId", "status");

-- CreateIndex
CREATE INDEX "ChapterUpdateJob_documentId_idx" ON "ChapterUpdateJob"("documentId");

-- CreateIndex
CREATE INDEX "ChapterUpdateJob_claimedBy_createdAt_idx" ON "ChapterUpdateJob"("claimedBy", "createdAt");

-- CreateIndex
CREATE INDEX "ChapterVersion_documentId_visibility_idx" ON "ChapterVersion"("documentId", "visibility");

-- CreateIndex
CREATE INDEX "ChapterVersion_repositoryId_idx" ON "ChapterVersion"("repositoryId");

-- CreateIndex
CREATE INDEX "ChapterVersion_authorId_idx" ON "ChapterVersion"("authorId");

-- CreateIndex
CREATE INDEX "ChapterVersionVote_userId_idx" ON "ChapterVersionVote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChapterVersionVote_versionId_userId_key" ON "ChapterVersionVote"("versionId", "userId");

-- CreateIndex
CREATE INDEX "ContentReport_repositoryId_createdAt_idx" ON "ContentReport"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_reporterId_idx" ON "ContentReport"("reporterId");

-- CreateIndex
CREATE INDEX "ContentReport_handledAt_idx" ON "ContentReport"("handledAt");

-- CreateIndex
CREATE INDEX "ImportRecord_repositoryId_idx" ON "ImportRecord"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRecord_userId_repositoryId_branch_key" ON "ImportRecord"("userId", "repositoryId", "branch");

-- CreateIndex
CREATE INDEX "ImportUpdateRun_userId_repositoryId_idx" ON "ImportUpdateRun"("userId", "repositoryId");

-- CreateIndex
CREATE INDEX "ImportJob_userId_createdAt_idx" ON "ImportJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportJob_status_lastHeartbeatAt_idx" ON "ImportJob"("status", "lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "ImportJob_owner_repo_branch_edition_status_idx" ON "ImportJob"("owner", "repo", "branch", "edition", "status");

-- CreateIndex
CREATE INDEX "ImportJobEvent_jobId_seq_idx" ON "ImportJobEvent"("jobId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ImportJobEvent_jobId_seq_key" ON "ImportJobEvent"("jobId", "seq");

-- CreateIndex
CREATE INDEX "Document_ownerUserId_idx" ON "Document"("ownerUserId");

-- CreateIndex
CREATE INDEX "Document_contentId_idx" ON "Document"("contentId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_repositoryId_path_ownerUserId_key" ON "Document"("repositoryId", "path", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentContent_contentHash_key" ON "DocumentContent"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentContent_requestFingerprint_key" ON "DocumentContent"("requestFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptionJob_documentId_key" ON "TranscriptionJob"("documentId");

-- CreateIndex
CREATE INDEX "TranscriptionJob_status_priority_idx" ON "TranscriptionJob"("status", "priority");

-- CreateIndex
CREATE INDEX "CreditGrantLedger_userId_createdAt_idx" ON "CreditGrantLedger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditGrantLedger_repositoryId_idx" ON "CreditGrantLedger"("repositoryId");

-- CreateIndex
CREATE INDEX "PendingCreditGrant_userId_status_idx" ON "PendingCreditGrant"("userId", "status");

-- CreateIndex
CREATE INDEX "PendingCreditGrant_repositoryId_status_idx" ON "PendingCreditGrant"("repositoryId", "status");

-- CreateIndex
CREATE INDEX "PendingCreditGrant_status_unlockAt_idx" ON "PendingCreditGrant"("status", "unlockAt");

-- CreateIndex
CREATE INDEX "GithubQuotaLog_createdAt_idx" ON "GithubQuotaLog"("createdAt");

-- CreateIndex
CREATE INDEX "GithubQuotaLog_fingerprint_createdAt_idx" ON "GithubQuotaLog"("fingerprint", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentChunk_documentId_idx" ON "DocumentChunk"("documentId");

-- CreateIndex
CREATE INDEX "DocumentChunk_contentId_idx" ON "DocumentChunk"("contentId");

-- CreateIndex
CREATE INDEX "DocumentChunk_semVerLabel_idx" ON "DocumentChunk"("semVerLabel");

-- CreateIndex
CREATE INDEX "DocumentChunk_contentType_idx" ON "DocumentChunk"("contentType");

-- CreateIndex
CREATE INDEX "idx_chunk_fts" ON "DocumentChunk" USING GIN ("searchVector");

-- CreateIndex
CREATE INDEX "idx_chunk_trgm_content" ON "DocumentChunk" USING GIN ("content" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_chunk_trgm_heading" ON "DocumentChunk" USING GIN ("heading" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ConversationMessage_conversationId_idx" ON "ConversationMessage"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationMessage_userId_idx" ON "ConversationMessage"("userId");

-- CreateIndex
CREATE INDEX "ConversationMessage_createdAt_idx" ON "ConversationMessage"("createdAt");

-- CreateIndex
CREATE INDEX "EpisodicEvent_userId_createdAt_idx" ON "EpisodicEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EpisodicEvent_eventType_idx" ON "EpisodicEvent"("eventType");

-- CreateIndex
CREATE INDEX "EpisodicEvent_repositoryId_eventType_idx" ON "EpisodicEvent"("repositoryId", "eventType");

-- CreateIndex
CREATE INDEX "EpisodicEvent_repositoryId_idx" ON "EpisodicEvent"("repositoryId");

-- CreateIndex
CREATE INDEX "MonitorEvent_kind_createdAt_idx" ON "MonitorEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "MonitorEvent_fingerprint_createdAt_idx" ON "MonitorEvent"("fingerprint", "createdAt");

-- CreateIndex
CREATE INDEX "MonitorEvent_sessionId_idx" ON "MonitorEvent"("sessionId");

-- CreateIndex
CREATE INDEX "Conversation_userId_repositoryId_idx" ON "Conversation"("userId", "repositoryId");

-- CreateIndex
CREATE INDEX "TokenUsageLog_userId_createdAt_idx" ON "TokenUsageLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TokenUsageLog_userId_repositoryId_idx" ON "TokenUsageLog"("userId", "repositoryId");

-- CreateIndex
CREATE INDEX "TokenUsageLog_userId_source_idx" ON "TokenUsageLog"("userId", "source");

-- CreateIndex
CREATE INDEX "TokenUsageLog_createdAt_idx" ON "TokenUsageLog"("createdAt");

-- CreateIndex
CREATE INDEX "TokenUsageLog_keyOrigin_createdAt_idx" ON "TokenUsageLog"("keyOrigin", "createdAt");

-- CreateIndex
CREATE INDEX "TokenUsageLog_conversationId_idx" ON "TokenUsageLog"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "McpBundle_slug_key" ON "McpBundle"("slug");

-- CreateIndex
CREATE INDEX "McpBundle_slug_idx" ON "McpBundle"("slug");

-- CreateIndex
CREATE INDEX "McpBundle_isStarterPack_isPinned_displayOrder_idx" ON "McpBundle"("isStarterPack", "isPinned", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_idx" ON "AdminAuditLog"("action");

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminUserId_idx" ON "AdminAuditLog"("adminUserId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "GatewaySecurityEvent_createdAt_idx" ON "GatewaySecurityEvent"("createdAt");

-- CreateIndex
CREATE INDEX "GatewaySecurityEvent_kind_createdAt_idx" ON "GatewaySecurityEvent"("kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DissectionCache_codeHash_key" ON "DissectionCache"("codeHash");

-- CreateIndex
CREATE INDEX "DissectionCache_codeHash_idx" ON "DissectionCache"("codeHash");

-- CreateIndex
CREATE INDEX "PlatformPromotion_isPinned_displayOrder_idx" ON "PlatformPromotion"("isPinned", "displayOrder");

-- CreateIndex
CREATE INDEX "PlatformPromotion_kind_startsAt_endsAt_idx" ON "PlatformPromotion"("kind", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalMcpToolPolicy_toolName_key" ON "GlobalMcpToolPolicy"("toolName");

-- CreateIndex
CREATE UNIQUE INDEX "TagRegistry_value_key" ON "TagRegistry"("value");

-- CreateIndex
CREATE INDEX "TagRegistry_kind_isActive_idx" ON "TagRegistry"("kind", "isActive");

-- CreateIndex
CREATE INDEX "McpOpenDoc_status_version_idx" ON "McpOpenDoc"("status", "version");

-- CreateIndex
CREATE INDEX "TutorialConceptNode_repositoryId_category_idx" ON "TutorialConceptNode"("repositoryId", "category");

-- CreateIndex
CREATE INDEX "TutorialConceptNode_conceptName_idx" ON "TutorialConceptNode"("conceptName");

-- CreateIndex
CREATE INDEX "TutorialConceptNode_repositoryId_canonicalKey_idx" ON "TutorialConceptNode"("repositoryId", "canonicalKey");

-- CreateIndex
CREATE INDEX "TutorialConceptNode_chunkId_idx" ON "TutorialConceptNode"("chunkId");

-- CreateIndex
CREATE INDEX "TutorialConceptNode_globalConceptId_idx" ON "TutorialConceptNode"("globalConceptId");

-- CreateIndex
CREATE UNIQUE INDEX "TutorialConceptNode_repositoryId_slug_key" ON "TutorialConceptNode"("repositoryId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalConcept_canonicalName_key" ON "GlobalConcept"("canonicalName");

-- CreateIndex
CREATE INDEX "GlobalConcept_canonicalName_idx" ON "GlobalConcept"("canonicalName");

-- CreateIndex
CREATE INDEX "TutorialConceptEdge_repositoryId_type_idx" ON "TutorialConceptEdge"("repositoryId", "type");

-- CreateIndex
CREATE INDEX "TutorialConceptEdge_targetId_idx" ON "TutorialConceptEdge"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "TutorialConceptEdge_sourceId_targetId_type_key" ON "TutorialConceptEdge"("sourceId", "targetId", "type");

-- CreateIndex
CREATE INDEX "ChapterQuiz_documentId_order_idx" ON "ChapterQuiz"("documentId", "order");

-- CreateIndex
CREATE INDEX "ChapterQuiz_repositoryId_idx" ON "ChapterQuiz"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "SystemPrompt_key_key" ON "SystemPrompt"("key");

-- CreateIndex
CREATE INDEX "PromptVersion_promptId_version_idx" ON "PromptVersion"("promptId", "version");

-- CreateIndex
CREATE INDEX "McpActiveSession_userId_lastSeenAt_idx" ON "McpActiveSession"("userId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpActiveSession_userId_clientName_key" ON "McpActiveSession"("userId", "clientName");

-- CreateIndex
CREATE UNIQUE INDEX "McpApiToken_tokenHash_key" ON "McpApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "McpApiToken_userId_idx" ON "McpApiToken"("userId");

-- CreateIndex
CREATE INDEX "McpCallLog_createdAt_idx" ON "McpCallLog"("createdAt");

-- CreateIndex
CREATE INDEX "McpCallLog_repositoryId_createdAt_idx" ON "McpCallLog"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "McpCallLog_status_createdAt_idx" ON "McpCallLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "McpCallLog_userId_createdAt_idx" ON "McpCallLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "McpCallLog_userId_clientName_createdAt_idx" ON "McpCallLog"("userId", "clientName", "createdAt");

-- CreateIndex
CREATE INDEX "McpCallLog_bundleId_idx" ON "McpCallLog"("bundleId");

-- CreateIndex
CREATE INDEX "McpCallLog_isFallback_createdAt_idx" ON "McpCallLog"("isFallback", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpUsageLedger_userId_day_key" ON "McpUsageLedger"("userId", "day");

-- CreateIndex
CREATE INDEX "TutorialOutline_repositoryId_isActive_idx" ON "TutorialOutline"("repositoryId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TutorialOutline_repositoryId_version_key" ON "TutorialOutline"("repositoryId", "version");

-- CreateIndex
CREATE INDEX "OutlinePart_outlineId_idx" ON "OutlinePart"("outlineId");

-- CreateIndex
CREATE INDEX "OutlineChapter_outlineId_idx" ON "OutlineChapter"("outlineId");

-- CreateIndex
CREATE INDEX "OutlineChapter_partId_idx" ON "OutlineChapter"("partId");

-- CreateIndex
CREATE INDEX "OutlineNode_chapterId_idx" ON "OutlineNode"("chapterId");

-- CreateIndex
CREATE INDEX "OutlineNode_documentId_idx" ON "OutlineNode"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalModelProvider_providerKey_key" ON "GlobalModelProvider"("providerKey");

-- CreateIndex
CREATE INDEX "GlobalModelProvider_isEnabled_displayOrder_idx" ON "GlobalModelProvider"("isEnabled", "displayOrder");

-- CreateIndex
CREATE INDEX "UserModelProvider_userId_isActive_idx" ON "UserModelProvider"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "UserModelProvider_userId_providerKey_key" ON "UserModelProvider"("userId", "providerKey");

-- CreateIndex
CREATE INDEX "OAuthAuthCode_clientId_idx" ON "OAuthAuthCode"("clientId");

-- CreateIndex
CREATE INDEX "OAuthAuthCode_userId_idx" ON "OAuthAuthCode"("userId");

-- CreateIndex
CREATE INDEX "OAuthAuthCode_expiresAt_idx" ON "OAuthAuthCode"("expiresAt");

-- CreateIndex
CREATE INDEX "DaemonTaskRun_task_createdAt_idx" ON "DaemonTaskRun"("task", "createdAt");

-- CreateIndex
CREATE INDEX "RepoSemanticGraph_owner_repo_idx" ON "RepoSemanticGraph"("owner", "repo");

-- CreateIndex
CREATE UNIQUE INDEX "RepoSemanticGraph_owner_repo_gitSha_key" ON "RepoSemanticGraph"("owner", "repo", "gitSha");

-- CreateIndex
CREATE INDEX "_BundleRepositories_B_index" ON "_BundleRepositories"("B");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReadingProgress" ADD CONSTRAINT "UserReadingProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReadingProgress" ADD CONSTRAINT "UserReadingProgress_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpfulVote" ADD CONSTRAINT "HelpfulVote_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpfulVote" ADD CONSTRAINT "HelpfulVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedRepo" ADD CONSTRAINT "SavedRepo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedRepo" ADD CONSTRAINT "SavedRepo_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoriteRepo" ADD CONSTRAINT "FavoriteRepo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoriteRepo" ADD CONSTRAINT "FavoriteRepo_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterUpdateJob" ADD CONSTRAINT "ChapterUpdateJob_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterUpdateJob" ADD CONSTRAINT "ChapterUpdateJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "DocumentContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterVersionVote" ADD CONSTRAINT "ChapterVersionVote_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ChapterVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterVersionVote" ADD CONSTRAINT "ChapterVersionVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRecord" ADD CONSTRAINT "ImportRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRecord" ADD CONSTRAINT "ImportRecord_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportUpdateRun" ADD CONSTRAINT "ImportUpdateRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportUpdateRun" ADD CONSTRAINT "ImportUpdateRun_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJobEvent" ADD CONSTRAINT "ImportJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "DocumentContent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptionJob" ADD CONSTRAINT "TranscriptionJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditGrantLedger" ADD CONSTRAINT "CreditGrantLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditGrantLedger" ADD CONSTRAINT "CreditGrantLedger_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingCreditGrant" ADD CONSTRAINT "PendingCreditGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingCreditGrant" ADD CONSTRAINT "PendingCreditGrant_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "DocumentContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodicEvent" ADD CONSTRAINT "EpisodicEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodicEvent" ADD CONSTRAINT "EpisodicEvent_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenUsageLog" ADD CONSTRAINT "TokenUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenUsageLog" ADD CONSTRAINT "TokenUsageLog_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenUsageLog" ADD CONSTRAINT "TokenUsageLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenUsageLog" ADD CONSTRAINT "TokenUsageLog_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ConversationMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorialConceptNode" ADD CONSTRAINT "TutorialConceptNode_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorialConceptNode" ADD CONSTRAINT "TutorialConceptNode_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorialConceptNode" ADD CONSTRAINT "TutorialConceptNode_globalConceptId_fkey" FOREIGN KEY ("globalConceptId") REFERENCES "GlobalConcept"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorialConceptEdge" ADD CONSTRAINT "TutorialConceptEdge_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TutorialConceptNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorialConceptEdge" ADD CONSTRAINT "TutorialConceptEdge_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TutorialConceptNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorialConceptEdge" ADD CONSTRAINT "TutorialConceptEdge_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterQuiz" ADD CONSTRAINT "ChapterQuiz_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterQuiz" ADD CONSTRAINT "ChapterQuiz_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "SystemPrompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpActiveSession" ADD CONSTRAINT "McpActiveSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpApiToken" ADD CONSTRAINT "McpApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpCallLog" ADD CONSTRAINT "McpCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpCallLog" ADD CONSTRAINT "McpCallLog_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpCallLog" ADD CONSTRAINT "McpCallLog_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "McpBundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpUsageLedger" ADD CONSTRAINT "McpUsageLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorialOutline" ADD CONSTRAINT "TutorialOutline_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutlinePart" ADD CONSTRAINT "OutlinePart_outlineId_fkey" FOREIGN KEY ("outlineId") REFERENCES "TutorialOutline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutlineChapter" ADD CONSTRAINT "OutlineChapter_outlineId_fkey" FOREIGN KEY ("outlineId") REFERENCES "TutorialOutline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutlineChapter" ADD CONSTRAINT "OutlineChapter_partId_fkey" FOREIGN KEY ("partId") REFERENCES "OutlinePart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutlineNode" ADD CONSTRAINT "OutlineNode_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "OutlineChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutlineNode" ADD CONSTRAINT "OutlineNode_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserModelProvider" ADD CONSTRAINT "UserModelProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthAuthCode" ADD CONSTRAINT "OAuthAuthCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthAuthCode" ADD CONSTRAINT "OAuthAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BundleRepositories" ADD CONSTRAINT "_BundleRepositories_A_fkey" FOREIGN KEY ("A") REFERENCES "McpBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BundleRepositories" ADD CONSTRAINT "_BundleRepositories_B_fkey" FOREIGN KEY ("B") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

