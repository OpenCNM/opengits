import { describe, it, expect } from 'vitest';
import {
  maskToken,
  getClientConfigJson,
  getClientAiPrompt,
  SUPPORTED_CLIENT_TYPES,
} from '@/components/mcp-connect/mcp-client-configs';

describe('maskToken - Token 脱敏展示', () => {
  it('处理空或无效 token', () => {
    expect(maskToken('')).toBe('');
    expect(maskToken(null as unknown as string)).toBe('');
    expect(maskToken(undefined as unknown as string)).toBe('');
  });

  it('短 token (<= 12 字符) 脱敏规则', () => {
    expect(maskToken('12345678')).toBe('123456****');
    expect(maskToken('opgts_12')).toBe('opgts_****');
    expect(maskToken('123456789012')).toBe('123456****');
  });

  it('真实 MCP Token (> 12 字符) 保留前缀与后4位，中间脱敏', () => {
    const rawToken = 'opgts_f9b27b59789fa1530ee063a8f20c5560';
    const masked = maskToken(rawToken);

    // 保留前 8 位 (opgts_f9) + **** + 后 4 位 (5560)
    expect(masked).toBe('opgts_f9****5560');
    // 确保脱敏后不包含敏感中间字符
    expect(masked).not.toContain('789fa1530ee063a8f20c');
  });
});

describe('getClientConfigJson & token display vs copy', () => {
  const endpoint = 'http://localhost:3000/api/mcp/hub';
  const realToken = 'opgts_f9b27b59789fa1530ee063a8f20c5560';

  it('未提供 token 时使用默认占位符', () => {
    const configStr = getClientConfigJson('cursor', endpoint);
    const config = JSON.parse(configStr);

    expect(config.mcpServers.opengits.headers.Authorization).toBe('Bearer YOUR_MCP_API_TOKEN');
  });

  it('使用脱敏 token 生成展示配置 (UI展示不暴露敏感明文)', () => {
    const masked = maskToken(realToken);
    const displayConfigStr = getClientConfigJson('cursor', endpoint, masked);
    const config = JSON.parse(displayConfigStr);

    expect(config.mcpServers.opengits.headers.Authorization).toBe(`Bearer ${masked}`);
    expect(displayConfigStr).not.toContain(realToken);
  });

  it('复制时使用的 rawConfig 包含完整明文 token', () => {
    const rawConfigStr = getClientConfigJson('cursor', endpoint, realToken);
    const config = JSON.parse(rawConfigStr);

    expect(config.mcpServers.opengits.headers.Authorization).toBe(`Bearer ${realToken}`);
  });

  it('支持所有 client 类型生成有效 JSON 配置', () => {
    for (const client of SUPPORTED_CLIENT_TYPES) {
      const masked = maskToken(realToken);
      const configStr = getClientConfigJson(client, endpoint, masked);
      const parsed = JSON.parse(configStr);
      expect(parsed.mcpServers.opengits.headers.Authorization).toBe(`Bearer ${masked}`);
    }
  });

  it('复制 Prompt 时包含完整明文 token', () => {
    const prompt = getClientAiPrompt('cursor', endpoint, realToken);
    expect(prompt).toContain(realToken);
  });
});
