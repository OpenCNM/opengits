import { describe, it, expect } from 'vitest';
import { parseMermaidToGraph, parseNodeDef } from '@/lib/mermaid/mermaidParser';

describe('mermaidParser hardening: full node shape peeling and connector parsing', () => {
  describe('parseNodeDef shape peeling', () => {
    it('correctly parses stadium shape (["..."])', () => {
      const node = parseNodeDef('A(["Stadium Shape"])');
      expect(node).toEqual({ id: 'A', label: 'Stadium Shape' });
    });

    it('correctly parses database cylinder shape [("...")]', () => {
      const node = parseNodeDef('B[("PostgreSQL Database")]');
      expect(node).toEqual({ id: 'B', label: 'PostgreSQL Database' });
    });

    it('correctly parses circle (("...")) and double circle ((("...")))', () => {
      expect(parseNodeDef('C(("Event Trigger"))')).toEqual({ id: 'C', label: 'Event Trigger' });
      expect(parseNodeDef('D((("Double Circle")))')).toEqual({ id: 'D', label: 'Double Circle' });
    });

    it('correctly parses subroutine [["..."]]', () => {
      const node = parseNodeDef('E[["Subroutine Call"]]');
      expect(node).toEqual({ id: 'E', label: 'Subroutine Call' });
    });

    it('correctly parses hexagon {{"..."}}', () => {
      const node = parseNodeDef('F{{"Hexagon Module"}}');
      expect(node).toEqual({ id: 'F', label: 'Hexagon Module' });
    });

    it('correctly parses rhombus/decision {"..."} and unquoted {decision}', () => {
      expect(parseNodeDef('G{"Is Valid?"}')).toEqual({ id: 'G', label: 'Is Valid?' });
      expect(parseNodeDef('H{Branching}')).toEqual({ id: 'H', label: 'Branching' });
    });

    it('correctly parses box with inner parentheses A["Label (Detail)"]', () => {
      const node = parseNodeDef('I["Label (Detail)"]');
      expect(node).toEqual({ id: 'I', label: 'Label (Detail)' });
    });

    it('correctly parses flag shape >["..."]', () => {
      const node = parseNodeDef('J>["Flag State"]');
      expect(node).toEqual({ id: 'J', label: 'Flag State' });
    });

    it('correctly parses Chinese identifiers and unescaped quotes', () => {
      const node = parseNodeDef('节点A["模块 \\"核心\\" 处理"]');
      expect(node).toEqual({ id: '节点A', label: '模块 "核心" 处理' });
    });
  });

  describe('Edge connectors and chained edges', () => {
    it('parses dotted arrows -.-> and dotted open lines -.-', () => {
      const code = `graph LR
        A -.-> B
        C -.- D`;
      const graph = parseMermaidToGraph(code);
      expect(graph.edges).toHaveLength(2);
      expect(graph.edges[0]).toEqual({ id: 'e-A-B', source: 'A', target: 'B', label: undefined });
      expect(graph.edges[1]).toEqual({ id: 'e-C-D', source: 'C', target: 'D', label: undefined });
    });

    it('parses inline labeled arrows (-- text -->, == text ==>, -. text .->)', () => {
      const code = `graph LR
        A -- yes --> B
        C == critical ==> D
        E -. optional .-> F`;
      const graph = parseMermaidToGraph(code);
      expect(graph.edges).toHaveLength(3);
      expect(graph.edges[0]).toEqual({ id: 'e-A-B', source: 'A', target: 'B', label: 'yes' });
      expect(graph.edges[1]).toEqual({ id: 'e-C-D', source: 'C', target: 'D', label: 'critical' });
      expect(graph.edges[2]).toEqual({ id: 'e-E-F', source: 'E', target: 'F', label: 'optional' });
    });

    it('parses multi-node chained edges A --> B --> C correctly', () => {
      const code = `graph TD
        A["Start"] -->|step 1| B{"Check"} -->|step 2| C["Finish"]`;
      const graph = parseMermaidToGraph(code);

      expect(graph.nodes).toHaveLength(3);
      expect(graph.nodes.map(n => n.id)).toEqual(['A', 'B', 'C']);
      expect(graph.nodes[0].label).toBe('Start');
      expect(graph.nodes[1].label).toBe('Check');
      expect(graph.nodes[2].label).toBe('Finish');

      expect(graph.edges).toHaveLength(2);
      expect(graph.edges[0]).toEqual({ id: 'e-A-B', source: 'A', target: 'B', label: 'step 1' });
      expect(graph.edges[1]).toEqual({ id: 'e-B-C', source: 'B', target: 'C', label: 'step 2' });
    });

    it('parses open line connectors with inline labels (-- text ---, == text ===, -. text .-) and labels with dashes', () => {
      const code = `graph LR
        A -- open-link --- B
        C == thick-open === D
        E -. dot-open .- F
        G -- my-dashed-label --> H`;
      const graph = parseMermaidToGraph(code);
      expect(graph.edges).toHaveLength(4);
      expect(graph.edges[0]).toEqual({ id: 'e-A-B', source: 'A', target: 'B', label: 'open-link' });
      expect(graph.edges[1]).toEqual({ id: 'e-C-D', source: 'C', target: 'D', label: 'thick-open' });
      expect(graph.edges[2]).toEqual({ id: 'e-E-F', source: 'E', target: 'F', label: 'dot-open' });
      expect(graph.edges[3]).toEqual({ id: 'e-G-H', source: 'G', target: 'H', label: 'my-dashed-label' });
    });

    it('parses & node branching syntax (A --> B & C, and A & B --> C & D)', () => {
      const code = `graph LR
        A["Source"] --> B["Target 1"] & C["Target 2"]
        D & E -->|merged| F & G`;
      const graph = parseMermaidToGraph(code);

      const nodeIds = graph.nodes.map(n => n.id);
      expect(nodeIds).toContain('A');
      expect(nodeIds).toContain('B');
      expect(nodeIds).toContain('C');
      expect(nodeIds).toContain('D');
      expect(nodeIds).toContain('E');
      expect(nodeIds).toContain('F');
      expect(nodeIds).toContain('G');

      // A connects to B and C
      expect(graph.edges).toContainEqual({ id: 'e-A-B', source: 'A', target: 'B', label: undefined });
      expect(graph.edges).toContainEqual({ id: 'e-A-C', source: 'A', target: 'C', label: undefined });

      // D & E connect to F & G (4 edges)
      expect(graph.edges).toContainEqual({ id: 'e-D-F', source: 'D', target: 'F', label: 'merged' });
      expect(graph.edges).toContainEqual({ id: 'e-D-G', source: 'D', target: 'G', label: 'merged' });
      expect(graph.edges).toContainEqual({ id: 'e-E-F', source: 'E', target: 'F', label: 'merged' });
      expect(graph.edges).toContainEqual({ id: 'e-E-G', source: 'E', target: 'G', label: 'merged' });
    });

    it('preserves & inside quoted node labels while splitting branching nodes', () => {
      const code = `graph LR
        A["Research & Development"] & B["Design & QA"] --> C["Production & Release"]`;
      const graph = parseMermaidToGraph(code);

      expect(graph.nodes.find(n => n.id === 'A')?.label).toBe('Research & Development');
      expect(graph.nodes.find(n => n.id === 'B')?.label).toBe('Design & QA');
      expect(graph.nodes.find(n => n.id === 'C')?.label).toBe('Production & Release');

      expect(graph.edges).toHaveLength(2);
      expect(graph.edges).toContainEqual({ id: 'e-A-C', source: 'A', target: 'C', label: undefined });
      expect(graph.edges).toContainEqual({ id: 'e-B-C', source: 'B', target: 'C', label: undefined });
    });

    it('ignores comments, subgraphs, styles, and class definitions', () => {
      const code = `graph TD
        %% This is a comment
        subgraph Core Module
          A --> B
        end
        style A fill:#f9f
        classDef default fill:#fff`;
      const graph = parseMermaidToGraph(code);

      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes.map(n => n.id)).toEqual(['A', 'B']);
      expect(graph.edges).toHaveLength(1);
    });

    it('ignores direction directive inside subgraphs without creating phantom nodes', () => {
      const code = `graph TD
        subgraph Sub1
          direction TB
          A --> B
        end`;
      const graph = parseMermaidToGraph(code);
      expect(graph.nodes.map(n => n.id)).toEqual(['A', 'B']);
      expect(graph.edges).toHaveLength(1);
    });

    it('preserves connectors inside quoted node labels without breaking parts', () => {
      const code = `graph LR
        A["Step 1: Input --> Transform"] --> B["Step 2: Output"]`;
      const graph = parseMermaidToGraph(code);
      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes[0]).toEqual({ id: 'A', label: 'Step 1: Input --> Transform' });
      expect(graph.nodes[1]).toEqual({ id: 'B', label: 'Step 2: Output' });
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]).toEqual({ id: 'e-A-B', source: 'A', target: 'B', label: undefined });
    });
  });
});
