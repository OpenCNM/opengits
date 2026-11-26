import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { RepoRuntime } from '@/lib/mcp/repo-tools';

const repoOptional = z.string().optional().describe('Optional "owner/repo" or repository ID to scope to one tutorial; omit to search across ALL tutorials');

const topicField = z.string().trim().min(1).optional().describe('The module, concept, or system to explain (defaults to the whole project)');
const detailField = z.enum(['brief', 'deep']).optional().default('deep').describe('"brief" = short 3-5 bullet summary; "deep" = layered diagram + responsibilities + design decisions');
const targetField = z.string().trim().min(1).describe('The code snippet, API call, or migration scenario to audit (e.g. "Async request headers in Next.js 15")');
const conceptField = z.string().trim().min(1).describe('The target concept to master (e.g. "上下文设计" or "context-window-design")');
const goalField = z.string().trim().min(1).describe('The project you want to scaffold (e.g. "Next.js 15 + Drizzle + auth 全栈项目")');

export interface ExplainArchitectureArgs {
  repository?: string;
  topic?: string;
  detail?: 'brief' | 'deep';
}

export interface AuditBreakingChangesArgs {
  repository?: string;
  target: string;
}

export interface LearnPathArgs {
  repository?: string;
  concept: string;
}

export interface ScaffoldProjectArgs {
  repository?: string;
  goal: string;
}

function scopeHint(runtime: RepoRuntime): string {
  return runtime.multiRepo
    ? '\n- 若已传 repository 参数，则检索限定在该教程；否则跨全 Hub 检索并注意结果中的 [Source: ...] 归因\n- 对 [Web Docs] 类型的官方文档教程，优先查阅官方 API 规范、配置要求与权威最佳实践，并在向用户输出结论时附带 Live URL 页面链接'
    : '';
}

// Return two separate ZodObjects via ternary; spreading conditional shapes breaks registerPrompt generic inference.
export async function registerRepositoryPrompts(server: McpServer, runtime: RepoRuntime): Promise<void> {
  const explainArgsSchema = runtime.multiRepo
    ? z.object({ repository: repoOptional, topic: topicField, detail: detailField })
    : z.object({ topic: topicField, detail: detailField });

  const auditArgsSchema = runtime.multiRepo
    ? z.object({ repository: repoOptional, target: targetField })
    : z.object({ target: targetField });

  const learnPathArgsSchema = runtime.multiRepo
    ? z.object({ repository: repoOptional, concept: conceptField })
    : z.object({ concept: conceptField });

  const scaffoldArgsSchema = runtime.multiRepo
    ? z.object({ repository: repoOptional, goal: goalField })
    : z.object({ goal: goalField });

  server.registerPrompt(
    'explain-architecture',
    {
      title: 'Explain Architecture',
      description: 'Explain how a module or system is architected: locate architecture docs, read the key sections, then synthesize a structured explanation with layers, responsibilities and dependencies.',
      argsSchema: explainArgsSchema,
    },
    async (args: ExplainArchitectureArgs) => {
      const topic = args.topic?.trim() || '该项目整体';
      const deep = (args.detail ?? 'deep') === 'deep';

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `请按以下工作流讲解「${topic}」的架构：\n` +
                `1. 调用 search 检索 "${topic}" 相关章节（filter='architecture', detail='locator'）${args.repository ? `，repository="${args.repository}"` : ''}\n` +
                `2. 可调用 browse(view='architecture'${args.repository ? `, repository="${args.repository}"` : ''}) 查看系统 C4 拓扑；若命中核心概念，调用 read(concept="<name>", action='details'${args.repository ? `, repository="${args.repository}"` : ''}) 获取原理/SOP，需要物理佐证时用 read_code\n` +
                `3. 对得分最高的 2-3 个命中调用 read(target=Address${args.repository ? `, repository="${args.repository}"` : ''}) 读取完整章节（Address 取自第 1 步输出）\n` +
                `4. 综合输出${deep ? '：ASCII 分层架构图、模块职责表、依赖关系、关键设计决策与演进方向' : '（简短模式）：3-5 条要点概括核心架构'}\n` +
                scopeHint(runtime),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    'audit-breaking-changes',
    {
      title: 'Audit Breaking Changes',
      description: 'Audit breaking changes & migration risks before upgrading: check the knowledge base for breaking changes, then produce a migration checklist with risk levels.',
      argsSchema: auditArgsSchema,
    },
    async (args: AuditBreakingChangesArgs) => {
      const target = args.target.trim();

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `请按以下工作流审计「${target}」的破坏性变更与迁移风险：\n` +
                `1. 调用 search（query="${target}", filter='gotchas', detail='locator'）${args.repository ? `，repository="${args.repository}"` : ''}\n` +
                `2. 对命中的关键章节调用 read(target=Address) 精读\n` +
                `3. 输出迁移清单：受影响 API、破坏点、迁移步骤、风险等级（BLOCKER/MAJOR/MINOR）\n` +
                scopeHint(runtime),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    'learn-path',
    {
      title: 'Learn Path',
      description: 'Master a target concept progressively: resolve its prerequisite chain via the knowledge graph (read with concept and action="path"), then read each step in order and confirm understanding with action="details".',
      argsSchema: learnPathArgsSchema,
    },
    async (args: LearnPathArgs) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `请按以下工作流带我递进掌握「${args.concept}」：\n` +
                `1. 调用 read（concept="${args.concept}", action='path'）${args.repository ? `，repository="${args.repository}"` : ''} 获取前置知识链\n` +
                `2. 按链上顺序（先前置后目标）逐个调用 read(concept=..., action='details') 深钻原理/SOP，必要时 read(target=Address) 精读溯源章节\n` +
                `3. 输出学习清单：每一步的概念、核心原理一句话、溯源 Address，以及最后的综合小结\n` +
                scopeHint(runtime),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    'scaffold-project',
    {
      title: 'Scaffold Project',
      description: 'Scaffold a new project from a tutorial: find matching tutorials on bookshelf, inspect curriculum structure, audit breaking changes, then produce a step-by-step build plan with risk levels.',
      argsSchema: scaffoldArgsSchema,
    },
    async (args: ScaffoldProjectArgs) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `请按以下工作流规划「${args.goal}」的项目搭建：\n` +
                `1. 选教程：Hub 模式调用 browse(query="${args.goal}") 筛选最契合的书架教程；单仓模式直接用 search(filter='architecture', query="${args.goal}", detail='locator') 检索技术栈初始化章节${args.repository ? `，repository="${args.repository}"` : ''}\n` +
                `2. 对选定教程调用 browse(view='course_map'${args.repository ? `, repository="${args.repository}"` : ''}) 看整体结构，再用 search(filter='gotchas', query="${args.goal}") 审计破坏性变更与迁移风险${args.repository ? `，repository="${args.repository}"` : ''}\n` +
                `3. 对命中的关键章节调用 read(target=Address) 精读（Address 取自第 1 步输出）\n` +
                `4. 输出项目搭建计划：技术选型确认、初始化步骤清单（每步附溯源 Address）、风险等级（BLOCKER/MAJOR/MINOR）\n` +
                scopeHint(runtime),
            },
          },
        ],
      };
    }
  );
}
