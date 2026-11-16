import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectTopologyTarget,
  fetchTopologySlice,
  formatTopologyGroundingPrompt,
  type TopologySliceResponse,
} from '@/lib/agent/topology-grounding';
import * as sidecarClient from '@/lib/sidecar-client';
import { TutorAgent } from '@/lib/agent/tutor-agent';

const mockGenerateText = vi.fn();
const mockStreamText = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: any[]) => mockGenerateText(...args),
  streamText: (...args: any[]) => mockStreamText(...args),
  stepCountIs: vi.fn(() => vi.fn()),
  hasToolCall: vi.fn(() => vi.fn()),
}));

vi.mock('@/lib/ai', () => ({
  getModel: vi.fn().mockReturnValue({}),
  modelName: 'mock-model',
}));

vi.mock('@/lib/agent/langfuse', () => ({
  langfuse: {
    trace: vi.fn().mockReturnValue({
      id: 'mock-trace-id',
      generation: vi.fn(),
    }),
    flushAsync: vi.fn(),
  },
  getCachedTutorPrompt: vi.fn().mockReturnValue('Base System Prompt'),
}));

vi.mock('@/lib/agent/tools', () => ({
  createAgentTools: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/mcp/doc-search', () => ({
  searchRepositoryDocs: vi.fn().mockResolvedValue([
    { path: 'src/index.ts', title: 'Index', content: 'export function emit() {}' },
  ]),
}));

vi.mock('@/lib/agent/context-formatter', () => ({
  formatHighDensityDocContext: vi.fn().mockReturnValue('[DOC CONTEXT: src/index.ts]'),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findUnique: vi.fn().mockResolvedValue({ gitSha: 'mocksha123' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'repo-1', owner: 'testowner', repo: 'testrepo' }),
    },
    conversation: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'conv-1' }),
    },
    episodicEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    conversationMessage: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('@/lib/prompt-registry', () => ({
  PromptRegistry: {
    getCompiledPrompt: vi.fn().mockResolvedValue({ compiledPrompt: 'Router Prompt' }),
  },
}));

vi.mock('@/lib/memory/working-memory', () => ({
  WorkingMemoryManager: {
    saveMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  },
}));

vi.mock('@/lib/analytics/token-usage', () => ({
  TokenUsageService: {
    logUsage: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('tutor-topology-grounding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectTopologyTarget', () => {
    it('detects source file from currentPath with /docs/owner/repo prefix', () => {
      const target = detectTopologyTarget({
        currentPath: '/docs/developit/mitt/src/index.ts',
        owner: 'developit',
        repo: 'mitt',
      });
      expect(target.path).toBe('src/index.ts');
    });

    it('ignores doc-only extensions in currentPath and falls back to topDocPath', () => {
      const target = detectTopologyTarget({
        currentPath: '/docs/developit/mitt/chapters/01-intro.mdx',
        topDocPath: 'src/core/mitt.ts',
        owner: 'developit',
        repo: 'mitt',
      });
      expect(target.path).toBe('src/core/mitt.ts');
    });

    it('detects source path mentioned explicitly in user query', () => {
      const target = detectTopologyTarget({
        currentPath: 'Unknown',
        query: 'Could you explain how lib/dispatcher.go is structured?',
      });
      expect(target.path).toBe('lib/dispatcher.go');
    });

    it('extracts candidate symbol from backtick identifier in query', () => {
      const target = detectTopologyTarget({
        currentPath: 'src/index.ts',
        query: 'What does `emit` do when event has no listeners?',
      });
      expect(target.path).toBe('src/index.ts');
      expect(target.symbol).toBe('emit');
    });

    it('extracts candidate symbol from function call syntax in query', () => {
      const target = detectTopologyTarget({
        currentPath: 'src/index.ts',
        query: 'How should I call dispatch(action)?',
      });
      expect(target.symbol).toBe('dispatch');
    });

    it('extracts candidate symbol from explain_selection JSON payload', () => {
      const target = detectTopologyTarget({
        currentPath: 'src/index.ts',
        query: JSON.stringify({ type: 'explain_selection', text: 'subscribe' }),
      });
      expect(target.symbol).toBe('subscribe');
    });

    it('extracts filePath and symbol from explain_code JSON payload', () => {
      const target = detectTopologyTarget({
        currentPath: '/docs/karpathy/micrograd/nn',
        query: JSON.stringify({
          type: 'explain_code',
          code: 'class Neuron(Module):\n  pass',
          language: 'python',
          filePath: 'micrograd/nn.py',
          symbol: 'Neuron',
          sectionTitle: 'Neuron 结构设计',
        }),
      });
      expect(target.path).toBe('micrograd/nn.py');
      expect(target.symbol).toBe('Neuron');
    });

    it('does not extract reserved stop-words as symbols', () => {
      const target = detectTopologyTarget({
        currentPath: 'src/index.ts',
        query: 'How does this work?',
      });
      expect(target.symbol).toBeUndefined();
    });
  });

  describe('fetchTopologySlice', () => {
    it('calls sidecar and returns valid slice when found', async () => {
      const mockSlice: TopologySliceResponse = {
        found: true,
        filePath: 'src/index.ts',
        targetSymbol: {
          name: 'emit',
          kind: 'function',
          startLine: 55,
          endLine: 70,
          exported: true,
        },
        role: 'core_contract',
        pageRank: 0.85,
        callers: [
          {
            callerFile: 'test/index.test.ts',
            callerSymbol: 'testEmit',
            calleeFile: 'src/index.ts',
            calleeSymbol: 'emit',
            line: 42,
          },
        ],
        callees: [],
        peerSymbols: [{ name: 'on', kind: 'function' }],
        topologyText: '[Physical Code Topology: src/index.ts#emit]\n- File: src/index.ts\n- Upstream Callers:\n  * test/index.test.ts:42 in testEmit',
      };

      const spy = vi.spyOn(sidecarClient, 'callSidecar').mockResolvedValue(mockSlice);

      const result = await fetchTopologySlice({
        owner: 'developit',
        repo: 'mitt',
        sha: 'abc1234',
        path: 'src/index.ts',
        symbol: 'emit',
      });

      expect(spy).toHaveBeenCalledWith(
        '/v1/graph/slice-context',
        expect.objectContaining({
          owner: 'developit',
          repo: 'mitt',
          path: 'src/index.ts',
          symbol: 'emit',
        }),
        expect.objectContaining({
          timeoutMs: 500,
        })
      );
      expect(result).toEqual(mockSlice);
    });

    it('returns null when sidecar indicates not found', async () => {
      vi.spyOn(sidecarClient, 'callSidecar').mockResolvedValue({
        found: false,
        filePath: 'nonexistent.ts',
        callers: [],
        callees: [],
        peerSymbols: [],
        topologyText: '',
      });

      const result = await fetchTopologySlice({
        owner: 'developit',
        repo: 'mitt',
        path: 'nonexistent.ts',
      });

      expect(result).toBeNull();
    });

    it('fails open (returns null) on network error or timeout', async () => {
      vi.spyOn(sidecarClient, 'callSidecar').mockRejectedValue(new Error('sidecar timeout'));

      const result = await fetchTopologySlice({
        owner: 'developit',
        repo: 'mitt',
        path: 'src/index.ts',
      });

      expect(result).toBeNull();
    });

    it('returns null immediately when required parameters are missing', async () => {
      const result = await fetchTopologySlice({
        owner: '',
        repo: 'mitt',
        path: 'src/index.ts',
      });
      expect(result).toBeNull();
    });
  });

  describe('formatTopologyGroundingPrompt', () => {
    it('formats valid slice into grounding header and topology content', () => {
      const slice: TopologySliceResponse = {
        found: true,
        filePath: 'src/index.ts',
        callers: [],
        callees: [],
        peerSymbols: [],
        topologyText: '- File: src/index.ts\n- Upstream Callers: None',
      };

      const prompt = formatTopologyGroundingPrompt(slice);
      expect(prompt).toContain('=== [PHYSICAL CODE TOPOLOGY GROUNDING (Verified Call Graph & AST Symbols)] ===');
      expect(prompt).toContain('The following physical code topology fact was deterministically extracted');
      expect(prompt).toContain('- File: src/index.ts');
    });

    it('returns empty string when slice is not found or has empty text', () => {
      expect(formatTopologyGroundingPrompt({
        found: false,
        filePath: 'test.ts',
        callers: [],
        callees: [],
        peerSymbols: [],
        topologyText: '',
      })).toBe('');
    });
  });

  describe('TutorAgent integration & Prompt Grounding', () => {
    it('injects Frame-0 topology grounding into systemPrompt when slice is available', async () => {
      const mockSlice: TopologySliceResponse = {
        found: true,
        filePath: 'src/index.ts',
        targetSymbol: {
          name: 'emit',
          kind: 'function',
          startLine: 55,
          endLine: 70,
          exported: true,
        },
        callers: [
          {
            callerFile: 'test/index.test.ts',
            callerSymbol: 'testEmit',
            calleeFile: 'src/index.ts',
            calleeSymbol: 'emit',
            line: 42,
          },
        ],
        callees: [],
        peerSymbols: [],
        topologyText: '[Physical Code Topology: src/index.ts#emit]\n- Upstream Callers: test/index.test.ts:42 in testEmit',
      };

      vi.spyOn(sidecarClient, 'callSidecar').mockResolvedValue(mockSlice);
      mockGenerateText.mockResolvedValue({ text: 'FACTUAL_SEARCH' });

      let capturedSystemPrompt = '';
      vi.spyOn(sidecarClient, 'callSidecarStream').mockImplementation((async (_path: string, body: any) => {
        capturedSystemPrompt = body.system;
        const stream = new ReadableStream({
          start(controller) {
            controller.close();
          }
        });
        return new Response(stream, { status: 200 });
      }) as any);

      await TutorAgent.run({
        messages: [{ role: 'user', content: 'Where is `emit` called from?' }],
        userId: 'user-1',
        sessionId: 'session-1',
        repositoryId: 'repo-1',
        owner: 'developit',
        repo: 'mitt',
        feynmanMode: false,
        currentPath: '/docs/developit/mitt/src/index.ts',
      });

      expect(capturedSystemPrompt).toContain('=== [PHYSICAL CODE TOPOLOGY GROUNDING (Verified Call Graph & AST Symbols)] ===');
      expect(capturedSystemPrompt).toContain('Physical Code Topology: src/index.ts#emit');
      expect(capturedSystemPrompt).toContain('test/index.test.ts:42 in testEmit');
    });

    it('fails open seamlessly when sidecar returns error or times out', async () => {
      vi.spyOn(sidecarClient, 'callSidecar').mockRejectedValue(new Error('Connection refused'));
      mockGenerateText.mockResolvedValue({ text: 'FACTUAL_SEARCH' });

      let streamCalled = false;
      let capturedSystemPrompt = '';
      vi.spyOn(sidecarClient, 'callSidecarStream').mockImplementation((async (_path: string, body: any) => {
        streamCalled = true;
        capturedSystemPrompt = body.system;
        const stream = new ReadableStream({
          start(controller) {
            controller.close();
          }
        });
        return new Response(stream, { status: 200 });
      }) as any);

      await TutorAgent.run({
        messages: [{ role: 'user', content: 'Where is `emit` called from?' }],
        userId: 'user-1',
        sessionId: 'session-1',
        repositoryId: 'repo-1',
        owner: 'developit',
        repo: 'mitt',
        feynmanMode: false,
        currentPath: '/docs/developit/mitt/src/index.ts',
      });

      expect(streamCalled).toBe(true);
      expect(capturedSystemPrompt).not.toContain('=== [PHYSICAL CODE TOPOLOGY GROUNDING');
      expect(capturedSystemPrompt).toContain('Base System Prompt');
    });
  });
});
