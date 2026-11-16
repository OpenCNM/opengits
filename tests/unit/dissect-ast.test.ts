import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fallbackLocalDissect } from '@/engine/dissect-driver';
import {
  extractExplanationFromMermaid,
  dissectCodeWithResilience,
  salvagePedagogyExplanation,
} from '@/lib/mermaid/resilience';
import { parseMermaidToGraph } from '@/lib/mermaid/mermaidParser';

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
const upsertMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    dissectionCache: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      update: (...args: unknown[]) => Promise.resolve(updateMock(...args)),
      upsert: (...args: unknown[]) => Promise.resolve(upsertMock(...args)),
    },
  },
}));

// sidecar 快路径（isAst=true 唯一来源）经 callSidecar 需 INTERNAL_API_TOKEN 且
// worker-sidecar 实际可达（WORKER_SIDECAR_URL，默认 127.0.0.1:8082）：缺令牌时
// callSidecar fail-fast 抛 SidecarError，缺实例时 fetch 失败同样回落本地假降级
// （isAst=false），isAst 断言必挂。故仅当两者同时显式注入时执行，否则该用例自动
// skip——同 go-sidecar job「WORKER_TEST_DATABASE_URL 未注入时本地自动 skip」惯例
// 与 storage-driver-s3 的 S3_IT_ENDPOINT 显式端点门控先例。注：本文件 prisma 已
// mock，无需测试库；令牌不单独作门（ai.ts 顶部 dotenv.config(override) 会从本地
// .env 静默注入，门形同虚设），以显式端点 WORKER_SIDECAR_URL 为准。
const HAS_LIVE_SIDECAR = Boolean(
  process.env.INTERNAL_API_TOKEN && process.env.WORKER_SIDECAR_URL
);

describe('P0 [Dissect AST] 纯 CPU 确定性 AST 投影与快慢路径协同', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
  });

  it('AST 投影生成合规 Mermaid 流程图与精准行号', () => {
    const code = `function calculateTotal(items) {
  let sum = 0;
  for (const item of items) {
    if (item.price > 0) {
      sum += item.price;
    }
  }
  return sum;
}`;
    const result = fallbackLocalDissect(code, 'javascript');
    expect(result.mermaidCode).toContain('flowchart TD');
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeLessThanOrEqual(8);

    const graph = parseMermaidToGraph(result.mermaidCode, code);
    expect(graph.nodes.length).toBe(result.nodes.length);

    for (const node of graph.nodes) {
      expect(node.payload?.lines).toBeDefined();
      const [start, end] = node.payload!.lines!;
      expect(start).toBeGreaterThanOrEqual(1);
      expect(end).toBeLessThanOrEqual(code.split('\n').length);
      expect(start).toBeLessThanOrEqual(end);
    }
  });

  it('从 Mermaid 注释中纯函数投影出 %% @Explanation 教学解释', () => {
    const mermaid = `flowchart TD
  N1["入口"] --> N2["出口"]
  %% @Payload[N1]: {"description": "入口说明", "lines": [1, 2]}
  %% @Payload[N2]: {"description": "出口说明", "lines": [3, 4]}
  %% @Explanation: {"intent": "采用门面模式提供单一入口", "tradeoffs": "空间换时间", "gotchas": "注意空指针"}
`;
    const explanation = extractExplanationFromMermaid(mermaid);
    expect(explanation).toBe('采用门面模式提供单一入口');
  });

  it.skipIf(!HAS_LIVE_SIDECAR)('用户未配置 Key 时，dissectCodeWithResilience 返回真实物理切片并显式置 isFallback=true 防污染', async () => {
    const code = `def add(a, b):\n    return a + b`;
    const res = await dissectCodeWithResilience({
      codeText: code,
      language: 'python',
      userId: undefined, // 匿名 / 未配置 Key
    });

    expect(res.mermaidCode).toContain('flowchart TD');
    expect(res.isFallback).toBe(true);
    expect(res.fallbackReason).toContain('未配置 AI 模型密钥');
    expect(res.isAst).toBe(true);
    expect(res.tierUsed).toBeLessThanOrEqual(2);
    // 确认绝非假降级（真实 AST 而非硬编码 3 方框）
    expect(res.mermaidCode).not.toContain('模块初始化 & 环境加载');
  });

  describe('Layer 1: 内存 0ms 状态机物理急救打捞 (salvagePedagogyExplanation)', () => {
    it('标准 JSON 载荷解析出完整的 intent, tradeoffs, gotchas 结构化教学段落', () => {
      const raw = JSON.stringify({
        intent: '通过门面模式简化通信流程',
        tradeoffs: '封装良好但增加了一层抽象调用',
        gotchas: '注意并发安全与连接泄露',
      });
      const salvaged = salvagePedagogyExplanation(raw);
      expect(salvaged.hasValidContent).toBe(true);
      expect(salvaged.fields.intent).toBe('通过门面模式简化通信流程');
      expect(salvaged.fields.tradeoffs).toBe('封装良好但增加了一层抽象调用');
      expect(salvaged.fields.gotchas).toBe('注意并发安全与连接泄露');
      expect(salvaged.explanationText).toContain('通过门面模式简化通信流程');
      expect(salvaged.explanationText).toContain('【架构权衡】\n封装良好但增加了一层抽象调用');
      expect(salvaged.explanationText).toContain('【注意事项】\n注意并发安全与连接泄露');
    });

    it('穿透 <think> 思考标签与 Markdown 围栏并清洗危险 HTML 脚本', () => {
      const raw = `
      <think>
      这是模型的思考过程，正在剖析该函数的边界条件...
      </think>
      \`\`\`json
      {
        "intent": "安全计算总和 <script>alert('xss')</script>",
        "tradeoffs": "遍历切片消耗 O(N) 时间"
      }
      \`\`\`
      `;
      const salvaged = salvagePedagogyExplanation(raw);
      expect(salvaged.hasValidContent).toBe(true);
      expect(salvaged.explanationText).not.toContain('<think>');
      expect(salvaged.explanationText).not.toContain('<script>');
      expect(salvaged.fields.intent).toContain('安全计算总和');
      expect(salvaged.fields.tradeoffs).toContain('遍历切片消耗 O(N) 时间');
    });

    it('从 Token 耗尽导致的尾部截断 JSON 中打捞出已闭合的意图与权衡字段', () => {
      // 模拟模型输出到 gotchas 时被截断（缺失右引号和右花括号）
      const truncatedRaw = `
      {
        "intent": "实现轻量级事件发射器",
        "tradeoffs": "内存占用极小但不支持持久化队列",
        "gotchas": "当监听器抛出未捕获异常时可能中
      `;
      const salvaged = salvagePedagogyExplanation(truncatedRaw);
      expect(salvaged.hasValidContent).toBe(true);
      expect(salvaged.fields.intent).toBe('实现轻量级事件发射器');
      expect(salvaged.fields.tradeoffs).toBe('内存占用极小但不支持持久化队列');
      expect(salvaged.fields.gotchas).toContain('当监听器抛出未捕获异常时可能中');
      expect(salvaged.explanationText).toContain('实现轻量级事件发射器');
      expect(salvaged.explanationText).toContain('【架构权衡】');
    });

    it('支持提取纯 Markdown 标题格式的教学解读文本', () => {
      const markdownRaw = `
### 架构意图
提供统一的模型调度网关。

### 架构权衡
增加了进程内中转但实现了模型供应商热插拔。

### 注意事项
必须校验环境变量中的 API 密钥格式。
      `;
      const salvaged = salvagePedagogyExplanation(markdownRaw);
      expect(salvaged.hasValidContent).toBe(true);
      expect(salvaged.fields.intent).toContain('提供统一的模型调度网关');
      expect(salvaged.fields.tradeoffs).toContain('增加了进程内中转');
      expect(salvaged.fields.gotchas).toContain('必须校验环境变量');
    });
  });
});
