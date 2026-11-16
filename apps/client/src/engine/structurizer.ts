// 结构化导航树节点契约（本文件唯一存活的类型面）。
// Structurizer 类已随 TS 计算层下沉 Go 一并退役（2026-11 死代码清算）：
// 导航树构建由 Go worker-sidecar 承载；此类型被 lib/docs、lib/mcp 等生产文件广泛消费。
export interface NavNode {
 name: string;
 title: string;
 shortTitle?: string;
 type: 'file' | 'directory';
 path: string;
 url: string;
 root?: boolean;
 children?: NavNode[];
}
