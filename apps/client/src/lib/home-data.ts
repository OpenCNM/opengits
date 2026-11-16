/**
 * 首页展示层共享类型。
 * 历史注记：本文件原有的 getHomePageData 服务端函数与 src/app/page.tsx 内联实现重复且零引用，
 * 已于推荐引擎 v1 轮收敛删除（消除双份漂移源）；真实数据流在 page.tsx。
 */

/** 讲法 chip 数据（同仓库多讲法分组展示；由 page.tsx 服务端从行数据派生） */
export interface EditionChip {
  /** Repository 行 id（行级收藏 connect 用） */
  id: string;
  /** 讲法 key（'' = 基础讲法；进入文档页 ?edition=） */
  edition: string;
  /** 显示名（repoProfile.editionLabel > 预设名 > 基础讲法） */
  label: string;
  /** 生成该讲法所用预设 id（可空，自定义讲法无预设） */
  presetId: string | null;
  isDefault: boolean;
  /** 该讲法行是否已在当前用户书架（行级 isSaved） */
  isSaved: boolean;
  progress: number;
  chapterCount: number;
  processedDocsCount: number;
  /** 书架费展示价（劳动账本 × 系数；0 = 免费/劳动未定价——收藏时以精确豁免判定为准） */
  shelfFeeEstimate?: number;
  /** 进入该讲法的文档页 URL（含 ?edition=） */
  docUrl: string;
  /** 讲法指纹（同配方同 hash；抽屉"另 N 个相同讲法"折叠显示依据；基础/未启用讲法缺省） */
  fingerprint?: string;
  /** 同源徽章：组内与主行不同仓库的讲法（clone/fork 转录归卡后的区分标识） */
  isSameSource?: boolean;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  transcriptionModels?: string[];
  transcriptionTokens?: number;
  /** 所属 Git 分支（默认 'main'） */
  branch?: string;
  /** Git Commit SHA（若已记录） */
  gitSha?: string | null;
  /** 该版本是否存在上游更新 */
  hasUpdate?: boolean;
  /** 导入时的 Commit SHA */
  importedSha?: string | null;
  /** 当前用户是否为该仓库维护者/属主 */
  isMaintainer?: boolean;
  /** 当前用户是否拥有该版本的管理/晋升权限 */
  canManage?: boolean;
  /** 维护者开启的上游仓库自动同步保鲜 */
  autoSyncEnabled?: boolean;
  /** 该版本是否开启社区接力 */
  relayEnabled?: boolean;
  /** 该版本是否已全量转录完成（客观事实） */
  isFullyTranscribed?: boolean;
  /** 该版本专属接力聚合状态 */
  relay?: {
    total: number;
    done: number;
    inProgress: number;
    participants?: Array<{
      userId?: string;
      name?: string | null;
      image?: string | null;
      active?: boolean;
    }>;
  } | null;
  /** 该版本专属管线审核分快照 */
  reviewPipeline?: unknown;
  /** 该版本专属大模型教研审评快照 */
  reviewLlm?: unknown;
  /** 该版本剩余可申请重新评分次数 (最多 3 次) */
  reviewAppealsRemaining?: number;
  savedCount?: number;
  helpfulCount?: number;
}

export interface DisplayRepo {
  id: string;
  owner: string;
  repo: string;
  branch?: string;
  isPublic?: boolean;
  title?: string;
  category?: string | null;
  tags?: string[];
  description?: string;
  descriptionZh?: string;
  descriptionEn?: string;
  isVerified?: boolean;
  starCount?: number;
  mcpCallCount?: number;
  likes?: number;
  views?: number;
  gitSha?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  documents?: Array<{ path: string }>;
  chapterCount: number;
  processedDocsCount: number;
  isFullyTranscribed: boolean;
  isSaved: boolean;
  savedCount: number;
  progress: number;
  viewedCount: number;
  hasUpdate: boolean;
  importedSha: string | null;
  isPinned: boolean;
  /** 书架行的跟随偏好（跟随公共副本自动同步 + 通知）；仅 my-shelf 行携带 */
  autoFollow?: boolean;
  /** 维护者开启的上游仓库自动同步保鲜 */
  autoSyncEnabled?: boolean;
  isMcpDisabled: boolean;
  /** 推荐分（服务端预计算：社区认可 + MCP 健康 + 审核基线 + 新鲜度，0-100） */
  recScore?: number;
  /** 书架费展示价（劳动账本 × 系数；0 = 免费/劳动未定价——收藏时以精确豁免判定为准） */
  shelfFeeEstimate?: number;
  lastReadPath: string | null;
  lastReadAt?: Date | string | null;
  /** 转录所用大模型集合（如 ["gemini-3.7-flash", "deepseek-v4-pro"]） */
  transcriptionModels?: string[];
  /** 累计转录消耗 Token 总计 */
  transcriptionTokens?: number;
  /** 同仓库多讲法分组（仅讲法数 >1 时由服务端填充；单讲法卡片零变化） */
  editionGroup?: { editions: EditionChip[] };
  [key: string]: any;
}
