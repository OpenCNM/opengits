/**
 * navTree 定点插删工具（plan-then-apply 执行器的结构补丁层）。
 *
 * 语义：绝不重排。除补丁目标节点外，树中所有节点保持原顺序、原层级。
 * - remove：摘除 path 匹配的节点（递归全树）
 * - add：把新节点插入到 position 节点之后（同父级）；position 缺省 → 追加到根列表尾部
 * - rename：原地改写 path 匹配节点的 path/url/name（上游文件改名/移动；
 *   不增删节点、不重排，节点标题保持原状——内容未变则标题未变）
 *
 * 新增节点构造由调用方负责（update-applier 按章节类型生成 NavNode）。
 */

import type { NavNode } from './structurizer';

// NavNode 唯一定义处在 engine/structurizer.ts（大纲双轨收敛：类型克隆一律引用主源）
export type { NavNode };

export interface NavTreePatch {
  /** 摘除的节点 path（Document.path） */
  remove: string[];
  /** 新增节点：插入到 positionPath 节点之后（positionPath 缺省 = 根列表尾部） */
  add: Array<{ node: NavNode; positionPath?: string }>;
  /**
   * 原地改名：命中节点改写 path/url/name（toUrl 由调用方按站点路由构造——
   * 补丁层不耦合 /docs 前缀知识）。缺省 = 无 rename。
   */
  rename?: Array<{ from: string; to: string; toUrl: string }>;
}

function cloneTree(nodes: NavNode[]): NavNode[] {
  return structuredClone(nodes);
}

/** 递归摘除 path 匹配的节点（返回新数组，不改原树） */
function removeByPath(nodes: NavNode[], path: string): NavNode[] {
  const result: NavNode[] = [];
  for (const node of nodes) {
    if (node.path === path) continue; // 摘除目标节点
    if (node.children && node.children.length > 0) {
      node.children = removeByPath(node.children, path);
    }
    result.push(node);
  }
  return result;
}

/** 递归原地改写 path 匹配节点的 path/url/name（入参树已是克隆，可安全变更） */
function renameByPath(nodes: NavNode[], from: string, to: string, toUrl: string): void {
  for (const node of nodes) {
    if (node.path === from) {
      node.path = to;
      node.url = toUrl;
      node.name = to.split('/').pop()?.replace(/\.(md|mdx)$/i, '') || to;
    }
    if (node.children && node.children.length > 0) {
      renameByPath(node.children, from, to, toUrl);
    }
  }
}

/**
 * 把 node 插入到 anchorPath 节点之后：
 * - 在根列表中找到 anchorPath → 插入其后
 * - 递归到各目录的 children 中查找
 * - 找不到 anchor → 返回 false（调用方决定：追加到根尾部）
 */
function insertAfter(nodes: NavNode[], anchorPath: string, node: NavNode): boolean {
  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i];
    if (current.path === anchorPath) {
      nodes.splice(i + 1, 0, node);
      return true;
    }
    const children = current.children;
    if (children && children.length > 0) {
      if (insertAfter(children, anchorPath, node)) return true;
    }
  }
  return false;
}

export function patchNavTree(navTree: NavNode[], patch: NavTreePatch): NavNode[] {
  let tree = cloneTree(navTree ?? []);

  for (const path of patch.remove) {
    tree = removeByPath(tree, path);
  }

  for (const r of patch.rename ?? []) {
    renameByPath(tree, r.from, r.to, r.toUrl);
  }

  for (const { node, positionPath } of patch.add) {
    if (positionPath) {
      const inserted = insertAfter(tree, positionPath, node);
      if (!inserted) tree.push(node); // 锚点缺失 → 尾部追加（不重排其他节点）
    } else {
      tree.push(node);
    }
  }

  return tree;
}
