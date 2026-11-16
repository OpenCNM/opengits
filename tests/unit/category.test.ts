// 分类别名归一（lib/constants CATEGORY_ALIASES）单测：表驱动收敛后口径不变的守护用例。

import { test, expect } from 'vitest';
import { normalizeCategory, UNTAGGED_CATEGORIES, CATEGORY_ALIASES, KNOWN_CATEGORY_LABELS } from '@/lib/constants';

test('别名归一：大小写 / 连字符 / 同义词统一到 10 大规范领域', () => {
  expect(normalizeCategory('llm')).toBe('AI');
  expect(normalizeCategory('Machine Learning')).toBe('AI');
  expect(normalizeCategory('web-docs')).toBe('Web Docs');
  expect(normalizeCategory('Web Docs')).toBe('Web Docs');
  expect(normalizeCategory('documentation')).toBe('Web Docs');
  expect(normalizeCategory('Frontend')).toBe('Web');
  expect(normalizeCategory('cloud-native')).toBe('Cloud');
  expect(normalizeCategory('ops')).toBe('Cloud');
  expect(normalizeCategory('CS')).toBe('Science');
  expect(normalizeCategory('Data Science')).toBe('Science');
  expect(normalizeCategory('other')).toBe('Others');
  expect(normalizeCategory('flutter')).toBe('Mobile');
  expect(normalizeCategory('unity')).toBe('Gaming');
  expect(normalizeCategory('arduino')).toBe('Hardware');
  expect(normalizeCategory('quant')).toBe('Finance');
  expect(normalizeCategory('awesome')).toBe('Others');
});

test('中文别名与标签归一：10 大核心领域及官方文档/其它', () => {
  expect(normalizeCategory('云原生')).toBe('Cloud');
  expect(normalizeCategory('后端与云原生')).toBe('Cloud');
  expect(normalizeCategory('系统底层')).toBe('Systems');
  expect(normalizeCategory('AI / 大模型')).toBe('AI');
  expect(normalizeCategory('人工智能')).toBe('AI');
  expect(normalizeCategory('大模型')).toBe('AI');
  expect(normalizeCategory('Web 全栈')).toBe('Web');
  expect(normalizeCategory('移动跨端')).toBe('Mobile');
  expect(normalizeCategory('游戏图形')).toBe('Gaming');
  expect(normalizeCategory('硬件嵌入式')).toBe('Hardware');
  expect(normalizeCategory('商业金融')).toBe('Finance');
  expect(normalizeCategory('科学计算')).toBe('Science');
  expect(normalizeCategory('经典图书')).toBe('Others');
  expect(normalizeCategory('官方文档')).toBe('Web Docs');
  expect(normalizeCategory('综合其它')).toBe('Others');
  expect(normalizeCategory('前端架构')).toBe('Web');
  expect(normalizeCategory('后端开发')).toBe('Cloud');
  expect(normalizeCategory('Linux 内核')).toBe('Systems');
});

test('不变量：KNOWN_CATEGORY_LABELS 的所有非 all 标签都能正确归一', () => {
  for (const [key, label] of Object.entries(KNOWN_CATEGORY_LABELS)) {
    if (key === 'all') continue;
    const expected = normalizeCategory(key);
    expect(normalizeCategory(label)).toBe(expected);
  }
});

test('赛道标题优先级：云原生优先于通用 GPU，赛道十拆解归入系统工程', () => {
  expect(normalizeCategory('赛道二：现代云原生 GPU、Serverless 算力、Edge 运行时与 WebGPU')).toBe('Cloud');
  expect(normalizeCategory('赛道十：软件设计哲学、经典架构模式与可重现构建')).toBe('Systems');
  expect(normalizeCategory('赛道一：GPU 算力内核、CUDA 架构、硬件加速与高性能推理引擎')).toBe('AI');
  expect(normalizeCategory('赛道三：Linux 内核底层机制、eBPF 网络可观测性与极速 I/O')).toBe('Systems');
  expect(normalizeCategory('赛道四：新型系统编程语言、编译器后端与异步并发运行时')).toBe('Systems');
  expect(normalizeCategory('赛道九：AI Agent 体系结构、上下文协议与提示词工程')).toBe('AI');
});

test('未知类目原样透传（保留原始大小写，交由 KNOWN_CATEGORY_LABELS 兜底展示）', () => {
  expect(normalizeCategory('量子计算')).toBe('量子计算');
  expect(normalizeCategory('设计美学')).toBe('设计美学');
});

test('空值边界：null/undefined → Others；纯空白与旧实现一致返回空串（交由展示层兜底）', () => {
  expect(normalizeCategory(null)).toBe('Others');
  expect(normalizeCategory(undefined)).toBe('Others');
  expect(normalizeCategory('  ')).toBe('');
});

test('UNTAGGED_CATEGORIES 与注册表口径一致（Web Docs / Others 不展示角标）', () => {
  expect(UNTAGGED_CATEGORIES.has('Web Docs')).toBe(true);
  expect(UNTAGGED_CATEGORIES.has('Others')).toBe(true);
  expect(UNTAGGED_CATEGORIES.has('AI')).toBe(false);
});

test('不变量：所有规范类目值再归一必须幂等（别名不得指向中间态）', () => {
  for (const target of new Set(Object.values(CATEGORY_ALIASES))) {
    expect(normalizeCategory(target)).toBe(target);
  }
});
