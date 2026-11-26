import type { NavNode } from './structurizer';

export type { NavNode };

export interface NavTreePatch {
  remove: string[];
  add: Array<{ node: NavNode; positionPath?: string }>;
  rename?: Array<{ from: string; to: string; toUrl: string }>;
}

function cloneTree(nodes: NavNode[]): NavNode[] {
  return structuredClone(nodes);
}

function removeByPath(nodes: NavNode[], path: string): NavNode[] {
  const result: NavNode[] = [];
  for (const node of nodes) {
    if (node.path === path) continue;
    if (node.children && node.children.length > 0) {
      node.children = removeByPath(node.children, path);
    }
    result.push(node);
  }
  return result;
}

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
      // Missing add anchors append at root instead of reordering existing nodes.
      if (!inserted) tree.push(node);
    } else {
      tree.push(node);
    }
  }

  return tree;
}
