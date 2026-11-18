export interface HourlyActivityPoint {
  hour: number; // 0..23
  count: number;
}

export interface TechLanguageStat {
  language: string;
  count: number;
  percentage: number;
}

export interface SavedRepoStat {
  owner: string;
  repo: string;
  savedCount: number;
}

export interface AdminKpiStats {
  // User Scale & Growth
  totalUsers: number;
  newUsersToday: number;
  activeUsersToday: number;

  // Repository Metrics
  totalRepositories: number;
  totalChunks: number;
  avgReposPerUser: number;
  avgSavedReposPerUser: number;

  // Engagement & Duration
  avgSessionDurationMin: number;
  totalUserTimeSpentHours: number;
  hourlyActivityMap: HourlyActivityPoint[];

  // MCP & Conversations
  totalMcpCalls: number;
  avgMcpCallsPerUser: number;
  blindSpotCount: number;
  blindSpotRate: number;
  mcpHitRate: number;
  totalConversations: number;
  avgConversationsPerUser: number;

  // Demographics & Preferences
  topLanguages: TechLanguageStat[];
  topSavedRepos: SavedRepoStat[];
}

export interface AdminRepoTranscriber {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
}

export interface AdminRepoSummary {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  semVerLabel: string | null;
  isPublic: boolean;
  publishedAt: string | null;
  reviewedAt?: string | null;
  reviewStatus?: string | null;
  rejectionReason?: string | null;
  documentCount: number;
  chunkCount: number;
  transcriptionCreditsEarned?: number;
  shelfFeeOverride?: number | null;
  shelfFeeEstimate?: number;
  transcribers?: AdminRepoTranscriber[];
  updatedAt: string;
}
