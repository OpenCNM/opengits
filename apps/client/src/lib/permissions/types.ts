export type PermissionLevel =
  | 'READ'          // 🟢 级：查看公开教程、AST 拓扑、搜索过滤（游客完全放行）
  | 'USER_ASSET'    // 🟡 级：收藏书架、管理专属 MCP Token、任务认领（需 GitHub 登录）
  | 'AI_COMPUTE';   // 🔴 级：转录新仓库、AI 划词问答、章节重新翻译（需 GitHub + API Key）

export interface PermissionGateOptions {
  level: 'USER_ASSET' | 'AI_COMPUTE';
  title?: string;
  contextText?: string;
  onResolved?: () => void;
}

export interface SignInOptionsArgs {
  targetRepo?: {
    owner: string;
    repo: string;
    title?: string;
  } | null;
  callbackUrl?: string;
}
