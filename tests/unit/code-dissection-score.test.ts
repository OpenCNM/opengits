import { describe, it, expect } from 'vitest';
import { scoreCodeComplexity } from '../../apps/client/src/lib/code-complexity';

describe('M02 [2.4] Code Dissection & Complexity Scoring', () => {
  it('2.4.1.1 简单代码块与高复杂度代码块评分差异', () => {
    const simpleCode = 'console.log("hello world");';
    const complexCode = `
      export async function handleRequest(req: Request) {
        try {
          const body = await req.json();
          if (body.type === 'ACTION') {
            for (const item of body.items) {
              await processItem(item);
            }
          }
        } catch (e) {
          logger.error(e);
        }
      }
    `;

    const scoreSimple = scoreCodeComplexity(simpleCode, 'javascript');
    const scoreComplex = scoreCodeComplexity(complexCode, 'typescript');

    expect(scoreComplex).toBeGreaterThan(scoreSimple);
  });
});
