import { describe, expect, it } from 'vitest';
import { computeQuantile, filterOutliersIQR } from '@/engine/analytics/user-journey';
import { sanitizeMermaid } from '@/lib/mermaid/resilience';

describe('Dimension 9: Engine Statistics & Technical Panorama (核心引擎统计与技术全景)', () => {
  describe('user-journey computeQuantile & filterOutliersIQR (分位数与离群值去噪)', () => {
    it('computeQuantile 边界测试：空数组返 0，单元素返自身，分位数自动钳位在 [0, 1]', () => {
      expect(computeQuantile([], 0.5)).toBe(0);
      expect(computeQuantile([42], 0.99)).toBe(42);
      expect(computeQuantile([10, 20, 30, 40, 50], -0.5)).toBe(10);
      expect(computeQuantile([10, 20, 30, 40, 50], 1.5)).toBe(50);
      expect(computeQuantile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    });

    it('filterOutliersIQR：正确剔除超出 Q3 + 1.5*IQR 的极端挂机异常值', () => {
      // 正常区间在 20~40 秒，离群挂机点 99999 秒
      const rawWaits = [20, 22, 25, 28, 30, 32, 35, 38, 40, 99999];
      const filtered = filterOutliersIQR(rawWaits);
      expect(filtered).not.toContain(99999);
      expect(filtered.length).toBe(9);
    });
  });

  describe('sanitizeMermaid (架构全景拓扑图语法装甲与自愈)', () => {
    it('复杂全景架构节点带特殊字符（冒号、括号、斜杠、泛型）确定性自愈包裹', () => {
      const rawArchitecture = `
\`\`\`mermaid
flowchart TD
  API[API Gateway: /v1/chat (Proxy)] --> Engine[Core Engine (AST & Tree)]
  Engine --> Cache[(Redis Cache: DB #0)]
\`\`\`
      `;
      const cleaned = sanitizeMermaid(rawArchitecture);
      expect(cleaned).toContain('flowchart TD');
      expect(cleaned).toContain('API[API Gateway: /v1/chat (Proxy)]');
      expect(cleaned).toContain('Engine[Core Engine (AST & Tree)]');
      expect(cleaned).toContain('Cache[(Redis Cache: DB #0)]');
      expect(cleaned).not.toContain('```');
    });

    it('包含思考标签 <think> 的全景拓扑输出彻底剥离引言与推理过程', () => {
      const withThink = `
<think>
Designing the technical architecture panorama for the repository.
Components: Ingest, Chunker, Storage.
</think>
flowchart LR
  Ingest[Ingest Pipeline] --> Chunker[Code Chunker]
      `;
      const cleaned = sanitizeMermaid(withThink);
      expect(cleaned).not.toContain('<think>');
      expect(cleaned).not.toContain('Designing the technical architecture');
      expect(cleaned.trim()).toBe('flowchart LR\n  Ingest[Ingest Pipeline] --> Chunker[Code Chunker]');
    });
  });
});
