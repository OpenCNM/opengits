import { prisma } from '@/lib/db';

export const DEFAULT_MCP_OPEN_DOCS_MARKDOWN = `# OpenGits MCP 网关开放文档

OpenGits 平台提供基于 Model Context Protocol (MCP) 标准的高性能知识库网关，为 Cursor、Claude Code、Codex 等 AI 客户端提供实时代码范例、架构蓝图与破坏性变更审计。

---

## 一、服务概览与规范

- **网关定位**: OpenGits 平台全量开源教程与知识库统一 MCP 服务端。
- **协议类型**: 标准 Model Context Protocol (MCP)，无状态 JSON-RPC（Streamable SSE），单 URL 即用。
- **只读数据保障**: 所有工具均属于分析与检索类型，无需写操作权限，100% 保护本地环境。
- **速率限制 (Rate Limit)**: 默认每个客户端标配 30 RPM (Requests Per Minute)，满足标准 IDE 高频交互需求。

---

## 二、接入认证（API Token）

MCP 端点要求登录身份。除 Web 会话外，智能体客户端（Cursor / Claude Code / Codex CLI）使用 **Bearer API Token** 接入：

1. 打开 **设置 → MCP API Token** 页面（\`/settings/mcp-tokens\`），创建 Token 并复制（明文仅创建时展示一次）。
2. 在客户端 MCP 配置的 \`headers\` 中加入 \`Authorization: Bearer <你的Token>\`（见下方配置示例）。

---

## 三、客户端一键接入指南

> 将下方 \`https://<your-domain>\` 替换为你的实际部署域名。

### 1. Cursor 配置
在 Cursor **Settings -> MCP** 中点击 **Add new global MCP server**，或直接粘贴至 \`~/.cursor/mcp.json\`：

\`\`\`json
{
  "mcpServers": {
    "opengits-hub": {
      "url": "https://<your-domain>/api/mcp/hub",
      "headers": {
        "Authorization": "Bearer <你的Token>"
      }
    }
  }
}
\`\`\`

### 2. Claude Code CLI 命令
在项目根目录 \`.mcp.json\` 中添加：

\`\`\`json
{
  "mcpServers": {
    "opengits-hub": {
      "type": "http",
      "url": "https://<your-domain>/api/mcp/hub",
      "headers": {
        "Authorization": "Bearer <你的Token>"
      }
    }
  }
}
\`\`\`

### 3. Codex 配置
在 Codex 配置文件中添加上述 \`mcpServers\` 相同节点（URL + headers）。

---

## 四、全站 5 大高内聚核心工具 API 辞典

OpenGits MCP 采用高内聚低冗余工具设计，全面支持单仓精搜与 Hub 全网检索：

### 1. 资产探查与全局导航
1. **list_resources**: 探查书架与全站教程资产列表。
   - **用途**: 罗列连通的所有教程/仓库，包含技术栈、标签、最后同步时间与最佳适用场景（best-used-for）。检索或精读前优先调用本工具确定目标仓库。
   - **输入**:
     - \`category?: string\` — 分类过滤（如 "Frontend", "AI", "Infrastructure"）
     - \`query?: string\` — 关键词过滤教程名称、标签或描述
   - **返回**: 教程 Markdown 清单及建议使用场景

### 2. 统一多维检索（RAG）
2. **search**: 跨文档、代码、架构与概念的统一深度检索。
   - **用途**: 在单仓或全 Hub 检索代码范例、接口定义、架构设计与步骤，返回精确的 Section Address 地址与代码片段。
   - **输入**:
     - \`query: string\` — 搜索关键词、代码片段、概念或技术问题（必填）
     - \`mode?: 'all' | 'docs' | 'code' | 'architecture' | 'concept'\` — 检索维度（默认 "all"）
     - \`token_budget?: number\` — 响应上下文 Token 预算（默认 4000）
     - \`detail?: 'locator' | 'summary' | 'full'\` — 结果详略度（默认 "locator"，返回 Section Address + 代码切片；"summary"/"full" 返回正文）
     - \`repository?: string\` — Hub 模式下可选，指定目标 "owner/repo" 或仓库 ID；不传则跨全库检索并附带 [Source] 归因
     - \`edition?: string\` — 可选讲法版本标识
   - **返回**: 精确段落定位（Section Address: \`path#headingPath\`）及代码块

### 3. 精准文档钻取（Token 友好）
3. **outline / read**: 钻取文档大纲（\`outline\`）或读取指定章节小节的正文内容（\`read\`）。
   - **用途**: 调用 \`outline\` 获取仓库架构拓扑与文档内部目录；调用 \`read\` 传入 \`target\`（文档路径或 \`path#headingPath\`）精准拉取指定章节内容，极大节省 Agent 提示词上下文。
   - **输入**:
     - \`repository: string\` — 仓库 "owner/repo" 或 ID（Hub 模式必填）
     - \`target?: string\` — 文档相对路径或精确小节地址（如 "docs/getting-started.md#Installation > Step 1"）
   - **返回**: Markdown 结构大纲或精准小节正文

### 4. 知识图谱深度探查
4. **explore_concept**: 知识图谱概念卡片、前置依赖与技能路径。
   - **用途**: 探查概念原理/SOP/设计意图、邻接依赖关系、递进学习链路、全局课程地图，或依据需求描述推荐最匹配的教程。
   - **输入**:
     - \`concept?: string\` — 概念标识或项目需求描述（action 为 "details", "neighbors", "path", "recommend" 时必填）
     - \`action?: 'details' | 'neighbors' | 'path' | 'course_map' | 'coverage' | 'recommend'\` — 探查模式（默认 "details"）
     - \`repository?: string\` — 指定目标仓库
   - **返回**: 概念卡片、邻接依赖、先修知识链、章节地图或推荐教程排序

### 5. 变更预警与踩坑预防
5. **check_breaking_changes**: 检查版本升级时的破坏性变更与迁移踩坑点。
   - **用途**: 在编写代码、升级依赖或重构前调用，评估潜在不兼容与已知 Gotcha。
   - **输入**:
     - \`query: string\` — 评估的代码片段、API 调用或升级场景（必填）
     - \`limit?: number\` — 最大返回数（默认 5，最大 5）
     - \`detail?: 'locator' | 'full'\` — 结果详略度（默认 "locator"）
     - \`repository?: string\` — 目标仓库
   - **返回**: 破坏性变更点列表、影响版本与安全迁移指引

---

## 五、AI Agent 提示词与规则范例

建议将以下规则粘贴至 Cursor 的 \`.cursorrules\`、Claude Code 的 \`CLAUDE.md\` 或 IDE 系统提示词中，指导 AI 智能唤起 OpenGits MCP：

\`\`\`markdown
# OpenGits MCP System Prompt Instruction
When asked about open-source library architecture, tutorial steps, code examples, or troubleshooting:
1. Call 'list_resources' first to discover available tutorials and their tech stacks.
2. Call 'search' (mode='docs' or mode='code') to retrieve section addresses and implementation snippets.
3. Call 'read' with a section address target (path#headingPath) to read exact content token-efficiently.
4. Call 'explore_concept' (action='path' or 'details') for deep conceptual architecture and learning chains.
5. Before upgrading dependencies or writing migration code, call 'check_breaking_changes'.
\`\`\`

---

## 六、常见问题与诊断 FAQ

- **Q: Cursor 提示 MCP Server Disconnected 如何处理？**
  - A: 检查 URL 网络畅通性，确认已在配置中加入 \`Authorization: Bearer\` 请求头，或使用终端调试指令 npx -y mcp-remote <url> 测试连接。
- **Q: 为什么 AI 没有主动调用 MCP 工具？**
  - A: 确保已配置上述 .cursorrules 提示词，或在提问时显式加上"请使用 OpenGits MCP 检索..."。
- **Q: 如何进行连通性探针测试？**
  - A: 在 OpenGits MCP 接入界面点击诊断测试按钮，即可在线发起 5 大场景自动化探针评测。
`;

export type McpDocStatus = 'DRAFT' | 'PENDING_REVIEW' | 'PUBLISHED' | 'ARCHIVED';

export async function getPublishedMcpOpenDoc() {
  let publishedDoc = await prisma.mcpOpenDoc.findFirst({
    where: { status: 'PUBLISHED' },
    orderBy: { version: 'desc' },
  });

  if (!publishedDoc) {
    publishedDoc = await prisma.mcpOpenDoc.create({
      data: {
        version: 1,
        status: 'PUBLISHED',
        title: 'OpenGits MCP 网关开放文档',
        markdown: DEFAULT_MCP_OPEN_DOCS_MARKDOWN,
        changelog: '初始全站 5 维标准规范发布',
        publishedAt: new Date(),
      },
    });
  }

  return {
    id: publishedDoc.id,
    version: publishedDoc.version,
    status: publishedDoc.status as McpDocStatus,
    title: publishedDoc.title,
    markdown: publishedDoc.markdown,
    changelog: publishedDoc.changelog,
    authorEmail: publishedDoc.authorEmail,
    publishedAt: publishedDoc.publishedAt ? publishedDoc.publishedAt.toISOString() : null,
    updatedAt: publishedDoc.updatedAt.toISOString(),
  };
}

export async function getAllMcpOpenDocVersions() {
  const docs = await prisma.mcpOpenDoc.findMany({
    orderBy: { version: 'desc' },
  });

  return docs.map((doc) => ({
    id: doc.id,
    version: doc.version,
    status: doc.status as McpDocStatus,
    title: doc.title,
    markdown: doc.markdown,
    changelog: doc.changelog,
    authorEmail: doc.authorEmail,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }));
}

export async function saveMcpOpenDocDraft(params: {
  markdown: string;
  title?: string;
  changelog?: string;
  authorEmail?: string;
  status?: McpDocStatus;
}) {
  const { markdown, title = 'OpenGits MCP 网关开放文档', changelog = '', authorEmail = '', status = 'DRAFT' } = params;

  // Check if there is an existing DRAFT or PENDING_REVIEW record to update
  const existingUnpublished = await prisma.mcpOpenDoc.findFirst({
    where: { status: { in: ['DRAFT', 'PENDING_REVIEW'] } },
    orderBy: { updatedAt: 'desc' },
  });

  if (existingUnpublished) {
    const updated = await prisma.mcpOpenDoc.update({
      where: { id: existingUnpublished.id },
      data: {
        markdown,
        title,
        changelog,
        status,
        authorEmail: authorEmail || existingUnpublished.authorEmail,
      },
    });
    return updated;
  }

  // Otherwise, create a new draft with (max_version + 1)
  const maxDoc = await prisma.mcpOpenDoc.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (maxDoc?.version || 0) + 1;

  const newDoc = await prisma.mcpOpenDoc.create({
    data: {
      version: nextVersion,
      status,
      title,
      markdown,
      changelog,
      authorEmail,
    },
  });

  return newDoc;
}

export async function publishMcpOpenDocVersion(docId: string, authorEmail?: string) {
  const targetDoc = await prisma.mcpOpenDoc.findUnique({
    where: { id: docId },
  });

  if (!targetDoc) return null;

  // Archive all currently PUBLISHED documents
  await prisma.mcpOpenDoc.updateMany({
    where: { status: 'PUBLISHED' },
    data: { status: 'ARCHIVED' },
  });

  // Promote target document to PUBLISHED
  const published = await prisma.mcpOpenDoc.update({
    where: { id: docId },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      ...(authorEmail ? { authorEmail } : {}),
    },
  });

  return published;
}

export async function resetMcpOpenDocToDefault(authorEmail?: string) {
  // Archive existing PUBLISHED docs
  await prisma.mcpOpenDoc.updateMany({
    where: { status: 'PUBLISHED' },
    data: { status: 'ARCHIVED' },
  });

  const maxDoc = await prisma.mcpOpenDoc.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (maxDoc?.version || 0) + 1;

  const resetDoc = await prisma.mcpOpenDoc.create({
    data: {
      version: nextVersion,
      status: 'PUBLISHED',
      title: 'OpenGits MCP 网关开放文档',
      markdown: DEFAULT_MCP_OPEN_DOCS_MARKDOWN,
      changelog: '已恢复初始全站 5 维标准规范模板',
      authorEmail: authorEmail || 'system@opengits.org',
      publishedAt: new Date(),
    },
  });

  return resetDoc;
}
