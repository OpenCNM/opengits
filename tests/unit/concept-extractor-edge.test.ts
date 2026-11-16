import { test, expect, describe } from 'vitest';
import {
  slugifyConcept,
  extractConceptsFromMarkdown,
  normalizeHeadingKey,
  matchChunkAnchor,
  MAX_CONCEPTS_PER_DOC,
} from '@/lib/mcp/concept-extractor';

describe('concept-extractor 边界与规则补全', () => {
  describe('slugifyConcept 规范化与 CJK 保留', () => {
    test('保留中文字符、英文字母与数字，其余符号转为连字符', () => {
      expect(slugifyConcept('React 19 事件循环原理')).toBe('react-19-事件循环原理');
      expect(slugifyConcept('C++ & Rust: 内存安全 @ 2026!')).toBe('c-rust-内存安全-2026');
      expect(slugifyConcept('   ---首尾连字符与多余空格---   ')).toBe('首尾连字符与多余空格');
    });

    test('全符号或空字符串时降级为 concept-${timestamp}', () => {
      const emptySlug = slugifyConcept('');
      expect(emptySlug).toMatch(/^concept-\d+$/);

      const symbolSlug = slugifyConcept('!@#$%^&*()+');
      expect(symbolSlug).toMatch(/^concept-\d+$/);
    });
  });

  describe('extractConceptsFromMarkdown AST 结构推断与容量上限', () => {
    test('纯 AST 结构分类：workflow（有序步骤）、reflection（引用块）、principle（代码块）与 architecture（纯结构论述）', () => {
      const md = `## 用户认证流程
这里讲解登录鉴权的执行步骤。
1. 校验 Token
2. 读取数据库

## 虚拟 DOM 核心原理
Diff 算法的数学概念与实现原理：
\`\`\`ts
function diff(prev, next) { return patch(prev, next); }
\`\`\`

## 架构演进与设计权衡
> 为什么选择 Rust 而不是 Go？Trade-off 在于零成本抽象与内存安全性。

## 基础设施配置
纯架构配置与目录结构说明，包含了基础微服务的部署拓扑，网络网关路由分发规则与跨可用区高可用容灾设计方案。`;

      const concepts = extractConceptsFromMarkdown(md, 'docs/guide.md');
      expect(concepts).toHaveLength(4);

      expect(concepts[0].conceptName).toBe('用户认证流程');
      expect(concepts[0].category).toBe('workflow');
      expect(concepts[0].sopSteps).toEqual(['校验 Token', '读取数据库']);

      expect(concepts[1].conceptName).toBe('虚拟 DOM 核心原理');
      expect(concepts[1].category).toBe('principle');

      expect(concepts[2].conceptName).toBe('架构演进与设计权衡');
      expect(concepts[2].category).toBe('reflection');
      expect(concepts[2].authorReflections).toContain('Trade-off');

      expect(concepts[3].conceptName).toBe('基础设施配置');
      expect(concepts[3].category).toBe('architecture');
    });

    test('低信息密度空过渡块过滤（低于字数下限且无代码/步骤/引用）', () => {
      const md = `## 核心微服务架构
这是一个非常完整的系统架构描述，详细记录了各微服务之间的通信拓扑与高可用部署设计方案。

## 总结
本章完。

## 参考文献
详见链接。`;

      const concepts = extractConceptsFromMarkdown(md, 'docs/arch.md');
      // 只有「核心微服务架构」信息密度达标，「总结」与「参考文献」无实质技术内容被自然过滤
      expect(concepts).toHaveLength(1);
      expect(concepts[0].conceptName).toBe('核心微服务架构');
    });

    test('单文档概念上限截断 (MAX_CONCEPTS_PER_DOC 源头控熵)', () => {
      const headings = Array.from(
        { length: 22 },
        (_, i) => `## 概念章节 ${i + 1}\n这是用于验证章节截断的详细正文描述段落，字数超过六十个字符以满足信息密度阈值过滤要求 ${i + 1}`
      ).join('\n\n');
      const concepts = extractConceptsFromMarkdown(headings, 'docs/long.md');
      expect(concepts).toHaveLength(MAX_CONCEPTS_PER_DOC);
      expect(concepts[0].conceptName).toBe('概念章节 1');
      expect(concepts[MAX_CONCEPTS_PER_DOC - 1].conceptName).toBe(`概念章节 ${MAX_CONCEPTS_PER_DOC}`);
    });
  });

  describe('normalizeHeadingKey 与 matchChunkAnchor 锚点鲁棒性', () => {
    test('normalizeHeadingKey 正确剥离 Markdown 标题标记与行内格式符号', () => {
      expect(normalizeHeadingKey('## 核心架构机制')).toBe('核心架构机制');
      expect(normalizeHeadingKey('### **加粗重要章节**')).toBe('加粗重要章节');
      expect(normalizeHeadingKey('1. `代码块标题` 与 _斜体_')).toBe('代码块标题 与 斜体');
      expect(normalizeHeadingKey('  ## 2、配置与环境变量  ')).toBe('配置与环境变量');
    });

    test('normalizeHeadingKey 鲁棒支持下划线前缀、多级数字与中英文括号', () => {
      // 下划线与数字前缀（曾因清洗顺序导致无法匹配）
      expect(normalizeHeadingKey('01_architecture')).toBe('architecture');
      expect(normalizeHeadingKey('## 01_architecture')).toBe('architecture');
      expect(normalizeHeadingKey('## **01_状态机设计**')).toBe('状态机设计');

      // 多级编号与点号分隔
      expect(normalizeHeadingKey('1.1. System Architecture')).toBe('system architecture');
      expect(normalizeHeadingKey('1.2.3 核心组件')).toBe('核心组件');

      // 括号序号
      expect(normalizeHeadingKey('(1) 核心组件')).toBe('核心组件');
      expect(normalizeHeadingKey('（2）生命周期钩子')).toBe('生命周期钩子');

      // 冒号序号与专有名词前导点保护
      expect(normalizeHeadingKey('1: 架构设计')).toBe('架构设计');
      expect(normalizeHeadingKey('1.1: 详细设计')).toBe('详细设计');
      expect(normalizeHeadingKey('## .NET Core 运行机制')).toBe('.net core 运行机制');
      expect(normalizeHeadingKey('.env 环境变量')).toBe('.env 环境变量');
      expect(normalizeHeadingKey('.gitignore 规范')).toBe('.gitignore 规范');
    });

    test('matchChunkAnchor 在带有 Markdown 符号或前缀编号时依然精准命中 chunk 锚点', () => {
      const chunks = [
        { id: 'chunk-1', heading: '核心架构机制', headingPath: '系统概览 > 核心架构机制' },
        { id: 'chunk-2', heading: 'Chapter 1 > 状态机设计', headingPath: 'Chapter 1 > 状态机设计' },
        { id: 'chunk-3', heading: 'Architecture Overview', headingPath: 'Architecture Overview' },
        { id: 'chunk-4', heading: 'Module A > 01_状态机设计', headingPath: 'Module A > 01_状态机设计' },
        { id: 'chunk-5', heading: 'AuthModule > 登录认证流程 (Part 1)', headingPath: 'AuthModule > 登录认证流程 (Part 1)' },
      ];

      // LLM 返回带有 ## 或 ** 的 sourceHeading
      const match1 = matchChunkAnchor(chunks, '## **核心架构机制**');
      expect(match1).not.toBeNull();
      expect(match1?.id).toBe('chunk-1');

      // 代码章节后缀匹配
      const match2 = matchChunkAnchor(chunks, '状态机设计');
      expect(match2).not.toBeNull();
      expect(match2?.id).toBe('chunk-2');

      // 下划线前缀源标题精准锚定普通标题
      const match3 = matchChunkAnchor(chunks, '01_architecture_overview');
      expect(match3).not.toBeNull();
      expect(match3?.id).toBe('chunk-3');

      // 包含 ">" 的分层代码标题中的带编号叶子（"01_状态机设计"）精准锚定
      const match4 = matchChunkAnchor([chunks[3]], '状态机设计');
      expect(match4).not.toBeNull();
      expect(match4?.id).toBe('chunk-4');

      // 长 chunk 切片后缀 "(Part 1)" 被平滑预清洗并精准锚定
      const match5 = matchChunkAnchor([chunks[4]], '登录认证流程');
      expect(match5).not.toBeNull();
      expect(match5?.id).toBe('chunk-5');
    });
  });
});
