import { describe, it, expect } from 'vitest';
import {
  TOOL_CONTRACTS,
  MCP_AVAILABLE_TOOLS,
  BUNDLE_TOOL_CONTRACTS,
  contractFor,
  contractSchema,
  contractDescription,
  HUB_SUFFIXES,
} from '@/lib/mcp/tool-contracts';

describe('MCP Tool Contracts Consistency (SSOT 规范与协议契约守恒)', () => {
  it('MCP_AVAILABLE_TOOLS 必须与 TOOL_CONTRACTS 保持 1:1 顺序与名称守恒', () => {
    expect(TOOL_CONTRACTS.length).toBe(MCP_AVAILABLE_TOOLS.length);
    for (let i = 0; i < TOOL_CONTRACTS.length; i++) {
      expect(TOOL_CONTRACTS[i].name).toBe(MCP_AVAILABLE_TOOLS[i]);
      expect(TOOL_CONTRACTS[i].canonicalOrder).toBe(i + 1);
    }
  });

  it('所有 13 个原生工具均具备非空规范描述与合法 hubSuffix', () => {
    const validSuffixes = new Set(['fanout', 'required', 'none']);
    for (const tool of TOOL_CONTRACTS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(validSuffixes.has(tool.hubSuffix)).toBe(true);
      expect(tool.singleSchema).toBeDefined();
      expect(tool.hubSchema).toBeDefined();
    }
  });

  it('hubSuffix="required" 的工具在 Hub 模式下强制要求 repository 参数', () => {
    const requiredTools = TOOL_CONTRACTS.filter((t) => t.hubSuffix === 'required');
    expect(requiredTools.length).toBeGreaterThan(0);

    for (const tool of requiredTools) {
      // singleSchema 中 repository 应为 optional 或不存在
      const singleShape = tool.singleSchema.shape as any;
      if (singleShape.repository) {
        expect(singleShape.repository.isOptional()).toBe(true);
      }

      // hubSchema 中 repository 必须为 required
      const hubShape = tool.hubSchema.shape as any;
      expect(hubShape.repository).toBeDefined();
      expect(hubShape.repository.isOptional()).toBe(false);
    }
  });

  it('hubSuffix="fanout" 的工具在 Hub 模式下 repository 为可选参数', () => {
    const fanoutTools = TOOL_CONTRACTS.filter((t) => t.hubSuffix === 'fanout');
    expect(fanoutTools.length).toBeGreaterThan(0);

    for (const tool of fanoutTools) {
      const hubShape = tool.hubSchema.shape as any;
      expect(hubShape.repository).toBeDefined();
      expect(hubShape.repository.isOptional()).toBe(true);
    }
  });

  it('contractDescription 按 multiRepo 形态正确追加 hubSuffix 模板', () => {
    const outlineDescSingle = contractDescription('outline', false);
    const outlineDescHub = contractDescription('outline', true);
    expect(outlineDescSingle).toBe(contractFor('outline')!.description);
    expect(outlineDescHub).toContain(HUB_SUFFIXES.fanout);

    const readDescSingle = contractDescription('read', false);
    const readDescHub = contractDescription('read', true);
    expect(readDescHub).toContain(HUB_SUFFIXES.required);
  });

  it('BUNDLE_TOOL_CONTRACTS 覆盖 bundle 4 核心工具', () => {
    const bundleToolNames = BUNDLE_TOOL_CONTRACTS.map((t) => t.name);
    expect(bundleToolNames).toEqual([
      'list_resources',
      'search',
      'read_document',
      'check_breaking_changes',
    ]);
  });
});
