import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runExploreConcept } from '@/lib/mcp/tools/concepts';
import { RepoRuntime } from '@/lib/mcp/tools/shared';

const conceptGraphMock = vi.hoisted(() => ({
  resolveConceptNode: vi.fn(),
  getConceptNeighbors: vi.fn(async () => []),
  getLearningPathConcepts: vi.fn(async () => []),
  formatNeighborsOutput: vi.fn(),
  formatLearningPathOutput: vi.fn(),
  getConceptCodeContext: vi.fn(async () => null),
  getConceptGrounding: vi.fn(async () => null),
  getConceptDependencies: vi.fn(async () => []),
  formatDependencyHintText: vi.fn(() => ''),
  neighborRelationTag: vi.fn(() => ''),
}));
vi.mock('@/lib/mcp/concept-graph', () => conceptGraphMock);

const prismaMock = vi.hoisted(() => ({
  repository: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  chapterQuiz: {
    findMany: vi.fn(),
  },
  tutorialConceptNode: {
    count: vi.fn(async () => 1),
    findMany: vi.fn(),
  },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

describe('MCP explore_concept Tool (Full Action Matrix)', () => {
  const mockRepo = {
    id: 'repo-micro-1',
    owner: 'karpathy',
    repo: 'micrograd',
    branch: 'master',
    gitSha: 'sha-micro-7bc',
    repoProfile: {},
  };

  const createRuntime = (repo: any = mockRepo, multiRepo = false): RepoRuntime => ({
    label: multiRepo ? 'the Hub' : 'this bookshelf',
    multiRepo,
    resolveRepository: async () => ({
      owner: repo.owner,
      repo: repo.repo,
      repository: repo,
      documents: [],
      navTree: [],
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    conceptGraphMock.resolveConceptNode.mockReset();
    conceptGraphMock.getConceptNeighbors.mockReset().mockResolvedValue([]);
    conceptGraphMock.getLearningPathConcepts.mockReset().mockResolvedValue([]);
    conceptGraphMock.getConceptGrounding.mockReset().mockResolvedValue(null);
    conceptGraphMock.getConceptDependencies.mockReset().mockResolvedValue([]);
    prismaMock.repository.findUnique.mockReset();
    prismaMock.chapterQuiz.findMany.mockReset();
    prismaMock.tutorialConceptNode.count.mockReset().mockResolvedValue(1);
    prismaMock.tutorialConceptNode.findMany.mockReset();
  });

  describe('action="details"', () => {
    it('缺少 concept 参数时返回错误指引', async () => {
      const res = await runExploreConcept({ action: 'details' }, createRuntime());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Error: "concept" parameter is required');
    });

    it('未找到目标概念时返回错误与寻径指引', async () => {
      conceptGraphMock.resolveConceptNode.mockResolvedValue(null);
      const res = await runExploreConcept({ action: 'details', concept: 'UnknownConcept' }, createRuntime());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Concept "UnknownConcept" not found in karpathy/micrograd');
    });

    it('成功返回概念包：包含原理、作者反思与定位 Address', async () => {
      conceptGraphMock.resolveConceptNode.mockResolvedValue({
        id: 'node-1',
        conceptName: 'Value 标量闭包',
        category: 'Core',
        headingPath: '第 1 章 > Value 节点',
        principlesText: '运算符重载实现前向建图',
        authorReflections: '为什么反向传播要用闭包',
        sopSteps: ['1. 定义 Value 类', '2. 重载运算符', '3. 拓扑排序'],
        summary: 'micrograd 的核心原子',
        subTopics: ['运算符重载', '拓扑排序'],
        tags: ['autograd', 'python'],
        document: { path: 'chapters/01.mdx' },
      });

      const res = await runExploreConcept({ action: 'details', concept: 'Value 标量闭包' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('🧠 概念详情 (Concept Details): Value 标量闭包 (Core)');
      expect(text).toContain('chapters/01.mdx');
      expect(text).toContain('- 核心原理 (Principles):');
      expect(text).toContain('运算符重载实现前向建图');
      expect(text).toContain('- 作者思考与 Trade-off 权衡:');
      expect(text).toContain('为什么反向传播要用闭包');
      expect(text).toContain('- 核心 SOP 开发步骤:');
    });
  });

  describe('action="neighbors" 与 action="path"', () => {
    it('action="neighbors" 返回概念上下游依赖关系', async () => {
      conceptGraphMock.resolveConceptNode.mockResolvedValue({
        id: 'node-neuron',
        conceptName: 'Neuron 神经元',
      });
      conceptGraphMock.getConceptNeighbors.mockResolvedValue([
        { conceptName: 'Value 标量闭包', relation: { type: 'prerequisite' } },
        { conceptName: 'Layer 分层', relation: { type: 'dependent' } },
      ]);
      conceptGraphMock.formatNeighborsOutput.mockReturnValue('Graph Neighbors for Neuron 神经元');

      const res = await runExploreConcept({ action: 'neighbors', concept: 'Neuron 神经元' }, createRuntime());
      expect(res.isError).toBeUndefined();
      expect(conceptGraphMock.formatNeighborsOutput).toHaveBeenCalled();
      expect(res.content[0].text).toContain('Graph Neighbors for Neuron 神经元');
    });

    it('action="path" 返回前置学习路径链', async () => {
      conceptGraphMock.resolveConceptNode.mockResolvedValue({
        id: 'node-neuron',
        conceptName: 'Neuron 神经元',
      });
      conceptGraphMock.getLearningPathConcepts.mockResolvedValue([
        { conceptName: 'Value 标量闭包', depth: 1 },
        { conceptName: 'Neuron 神经元', depth: 2 },
      ]);
      conceptGraphMock.formatLearningPathOutput.mockReturnValue('Learning Path: Value -> Neuron');

      const res = await runExploreConcept({ action: 'path', concept: 'Neuron 神经元' }, createRuntime());
      expect(res.isError).toBeUndefined();
      expect(conceptGraphMock.formatLearningPathOutput).toHaveBeenCalled();
      expect(res.content[0].text).toContain('Learning Path: Value -> Neuron');
    });
  });

  describe('action="quiz"', () => {
    it('返回章节概念配套的选择题、选项与正确答案解析', async () => {
      conceptGraphMock.resolveConceptNode.mockResolvedValue({
        id: 'node-1',
        conceptName: 'Value 标量闭包',
        documentId: 'doc-1',
      });

      prismaMock.chapterQuiz.findMany.mockResolvedValue([
        {
          id: 'quiz-1',
          order: 0,
          question: '为什么 _backward 中使用 += 而不是 =？',
          options: ['纯属习惯', '处理多分支梯度累加', '为了节省内存'],
          correctIndex: 1,
          explanation: '多元微积分链式法则要求复用节点的梯度必须累加。',
        },
      ]);

      const res = await runExploreConcept({ action: 'quiz', concept: 'Value 标量闭包' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('# 📝 Chapter Quizzes for concept "Value 标量闭包"');
      expect(text).toContain('### Q1: 为什么 _backward 中使用 += 而不是 =？');
      expect(text).toContain('- B. 处理多分支梯度累加');
      expect(text).toContain('(Answer: B)');
      expect(text).toContain('Explanation: 多元微积分链式法则要求复用节点的梯度必须累加。');
    });

    it('当章节无配套习题时提示暂无测试题', async () => {
      conceptGraphMock.resolveConceptNode.mockResolvedValue({
        id: 'node-1',
        conceptName: 'Value 标量闭包',
        documentId: 'doc-1',
      });
      prismaMock.chapterQuiz.findMany.mockResolvedValue([]);

      const res = await runExploreConcept({ action: 'quiz', concept: 'Value 标量闭包' }, createRuntime());
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('No structured quizzes persisted for this chapter');
    });
  });

  describe('action="course_map"', () => {
    it('按章节教学顺序输出课程大纲概念图谱', async () => {
      prismaMock.repository.findUnique.mockResolvedValue({
        id: 'repo-micro-1',
        repoProfile: {
          codeClusters: [
            { teachingOrder: 1, title: '原子引擎', files: ['micrograd/engine.py'] },
            { teachingOrder: 2, title: '分层网络', files: ['micrograd/nn.py'] },
          ],
        },
        navTree: [],
      });

      const res = await runExploreConcept({ action: 'course_map' }, createRuntime());
      expect(res.isError).toBeUndefined();
      const text = res.content[0].text;
      expect(text).toContain('Course Map — 2 章 / 2 文件');
      expect(text).toContain('1. 原子引擎（1 文件）');
      expect(text).toContain('2. 分层网络（1 文件）');
    });
  });
});
