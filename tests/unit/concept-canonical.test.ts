import { test, expect, describe } from 'vitest';
import {
  planCanonicalGroups,
  canonicalFieldsFor,
} from '@/lib/mcp/concept-canonical';

describe('concept-canonical 仓内归并纯函数', () => {
  describe('planCanonicalGroups 分组', () => {
    test('🧪 [4.1.2.1] 同名不同变体归为一组（去空白/小写/剥前导编号/统一规范化 canonicalKey）', () => {
      const plans = planCanonicalGroups([
        { id: 'a', conceptName: '事件循环' },
        { id: 'b', conceptName: '事件循环' },
        { id: 'c', conceptName: '1. 事件循环' },   // 前导编号被剥除
        { id: 'd', conceptName: 'Event Loop' },     // 小写归一后不同 key，单独成组
      ]);
      expect(plans.size).toBe(2);

      const loop = plans.get('事件循环')!;
      expect(loop).toBeDefined();
      expect(loop.memberIds).toEqual(['a', 'b', 'c']);
      expect(loop.variants).toEqual(['1. 事件循环', '事件循环']);

      const en = plans.get('event loop')!;
      expect(en.memberIds).toEqual(['d']);
    });

    test('🧪 [4.1.2.1] 代表名取频次最高者；同频取字典序最小（确定性决胜）', () => {
      const plans = planCanonicalGroups([
        { id: 'a', conceptName: '事件循环（下）' },
        { id: 'b', conceptName: '事件循环' },
        { id: 'c', conceptName: '事件循环' },
      ]);
      // 「事件循环」出现 2 次 > 「事件循环（下）」1 次
      expect(plans.get('事件循环')!.canonicalName).toBe('事件循环');

      const tie = planCanonicalGroups([
        { id: 'x', conceptName: 'Beta 名称' },
        { id: 'y', conceptName: 'Alpha 名称' },
      ]);
      // 同频（各 1 次）→ 字典序最小者胜出，重跑结果一致
      expect(tie.get('alpha 名称')!.canonicalName).toBe('Alpha 名称');
    });

    test('归一化为空 key 的节点不入组（保持未归并）', () => {
      const plans = planCanonicalGroups([
        { id: 'a', conceptName: '1. ' },       // 剥编号后为空
        { id: 'b', conceptName: '   ' },       // 纯空白
        { id: 'c', conceptName: '有效概念' },
      ]);
      expect(plans.size).toBe(1);
      expect(plans.has('有效概念')).toBe(true);
    });

    test('空输入返回空 Map', () => {
      expect(planCanonicalGroups([]).size).toBe(0);
    });
  });

  describe('canonicalFieldsFor 写入初值', () => {
    test('正常名称：key 为归一化形式，name 取 trim 后原名', () => {
      expect(canonicalFieldsFor('  Event Loop  ')).toEqual({
        canonicalKey: 'event loop',
        canonicalName: 'Event Loop',
      });
    });

    test('归一化为空时 canonicalKey 为 null（未归并语义）', () => {
      expect(canonicalFieldsFor('1. ')).toEqual({ canonicalKey: null, canonicalName: '1.' });
      expect(canonicalFieldsFor('')).toEqual({ canonicalKey: null, canonicalName: '' });
    });
  });
});
