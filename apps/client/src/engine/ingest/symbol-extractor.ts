export interface SymbolEntry {
  name: string;
  kind: 'function' | 'type';
  startLine: number;
  endLine: number;
  exported: boolean;
  golden?: boolean;
  importers?: number;
}
