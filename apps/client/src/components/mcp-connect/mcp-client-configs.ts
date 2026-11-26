import * as m from '@/paraglide/messages';

export type ClientType = 'cursor' | 'claude-code' | 'zcode' | 'codex' | 'antigravity';

export function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 12) return `${token.slice(0, 6)}****`;
  return `${token.slice(0, 8)}****${token.slice(-4)}`;
}

export interface McpClientDefinition {
  type: ClientType;
  label: string;
  configPathHint: string;
  generateConfig: (endpointUrl: string, token?: string) => Record<string, any>;
  generatePrompt: (configJson: string, endpointUrl: string, token?: string) => string;
}

export function defineMcpClient(opts: {
  type: ClientType;
  label: string;
  configPathHint: string;
  serverType?: string;
  urlKey?: 'url' | 'serverUrl';
  commandSnippet?: (endpointUrl: string, token?: string) => string;
}): McpClientDefinition {
  const urlProp = opts.urlKey ?? 'url';
  return {
    type: opts.type,
    label: opts.label,
    configPathHint: opts.configPathHint,
    generateConfig: (endpointUrl: string, token?: string) => {
      const tokenValue = token || 'YOUR_MCP_API_TOKEN';
      const serverConfig: Record<string, any> = {
        [urlProp]: endpointUrl,
        headers: {
          Authorization: `Bearer ${tokenValue}`,
        },
      };
      if (opts.serverType) {
        serverConfig.type = opts.serverType;
      }
      return {
        mcpServers: {
          opengits: serverConfig,
        },
      };
    },
    generatePrompt: (configJson: string, endpointUrl: string, token?: string) => {
      const tokenNote = token ? m.mcp_prompt_token_included() : m.mcp_prompt_token_replace();
      if (opts.commandSnippet) {
        return m.mcp_prompt_command_snippet_template({
          label: opts.label,
          command: opts.commandSnippet(endpointUrl, token),
          config: configJson,
          tokenNote,
        });
      }
      return m.mcp_prompt_json_config_template({
        label: opts.label,
        configPath: opts.configPathHint,
        config: configJson,
        tokenNote,
      });
    },
  };
}

export const MCP_CLIENT_REGISTRY: Record<ClientType, McpClientDefinition> = {
  cursor: defineMcpClient({
    type: 'cursor',
    label: 'Cursor',
    configPathHint: m.mcp_config_hint_cursor(),
  }),

  'claude-code': defineMcpClient({
    type: 'claude-code',
    label: 'Claude Code',
    configPathHint: m.mcp_config_hint_claude(),
    serverType: 'http',
    commandSnippet: (url, token) =>
      `claude mcp add opengits ${url} --header "Authorization: Bearer ${token || 'YOUR_MCP_API_TOKEN'}"`,
  }),

  zcode: defineMcpClient({
    type: 'zcode',
    label: 'ZCode',
    configPathHint: m.mcp_config_hint_zcode(),
  }),

  codex: defineMcpClient({
    type: 'codex',
    label: 'Codex',
    configPathHint: m.mcp_config_hint_codex(),
  }),

  antigravity: defineMcpClient({
    type: 'antigravity',
    label: 'Antigravity',
    configPathHint: m.mcp_config_hint_antigravity(),
    urlKey: 'serverUrl',
  }),
};

export const CLIENT_LABEL_MAP: Record<ClientType, string> = Object.fromEntries(
  Object.values(MCP_CLIENT_REGISTRY).map((c) => [c.type, c.label])
) as Record<ClientType, string>;

export const SUPPORTED_CLIENT_TYPES: ClientType[] = Object.keys(MCP_CLIENT_REGISTRY) as ClientType[];

export function getClientConfigJson(type: ClientType, endpointUrl: string, token?: string): string {
  const client = MCP_CLIENT_REGISTRY[type];
  const config = client ? client.generateConfig(endpointUrl, token) : {
    mcpServers: {
      opengits: {
        url: endpointUrl,
        headers: { Authorization: `Bearer ${token || 'YOUR_MCP_API_TOKEN'}` },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

export function getClientAiPrompt(type: ClientType, endpointUrl: string, token?: string): string {
  const client = MCP_CLIENT_REGISTRY[type];
  const configJson = getClientConfigJson(type, endpointUrl, token);
  return client
    ? client.generatePrompt(configJson, endpointUrl, token)
    : m.mcp_prompt_generic_help({ config: configJson });
}
