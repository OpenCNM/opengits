import { describe, expect, it, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { setLocale } from '@/paraglide/runtime.js';
import {
  AXES_ORDER,
  getAxisConfig,
  compassPoints,
} from '@/components/repo/utils/radarGeometry';
import {
  buildRadarAxes,
  getPedagogicalArchetype,
} from '@/components/repo/hooks/useRadarProfile';
import { DirectionalDiamondSvg } from '@/components/repo/RepoScoreRadar';

describe('四向偏向矛头罗盘 (Directional Diamond Compass) 核心算法与渲染验证', () => {
  beforeEach(() => {
    setLocale('zh-CN');
  });

  it('1. 四正交轴系定义符合笛卡尔认知平面 (北架构 -> 东源码 -> 南通俗 -> 西全景)', () => {
    expect(AXES_ORDER).toEqual(['depth', 'codeFidelity', 'pedagogy', 'coverage']);
    const cfg = getAxisConfig();
    expect(cfg.depth.label).toBe('架构深度');
    expect(cfg.depth.direction).toBe('north');
    expect(cfg.codeFidelity.label).toBe('源码剖析');
    expect(cfg.codeFidelity.direction).toBe('east');
    expect(cfg.pedagogy.label).toBe('深入浅出');
    expect(cfg.pedagogy.direction).toBe('south');
    expect(cfg.coverage.label).toBe('体系全景');
    expect(cfg.coverage.direction).toBe('west');
  });

  it('2. buildRadarAxes 正确将 LLM 与物理数据投影至 4 轴', () => {
    const axes = buildRadarAxes(
      {
        total: 85,
        dimensions: [
          { key: 'depth', label: '深度', score: 90 },
          { key: 'coverage', label: '全景', score: 80 },
        ],
      },
      {
        overallScore: 92,
        archetype: 'CODE_DIVER',
        dimensions: [
          { name: 'depth', score: 95, comment: '架构深入' },
          { name: 'codeFidelity', score: 98, comment: '关键核心源码' },
          { name: 'pedagogy', score: 85, comment: '语言通俗' },
          { name: 'coverage', score: 88, comment: '覆盖全面' },
        ],
      }
    );

    expect(axes).toHaveLength(4);
    expect(axes[0].key).toBe('depth');
    expect(axes[0].value).toBe(95);
    expect(axes[1].key).toBe('codeFidelity');
    expect(axes[1].value).toBe(98);
    expect(axes[2].key).toBe('pedagogy');
    expect(axes[2].value).toBe(85);
    expect(axes[3].key).toBe('coverage');
    expect(axes[3].value).toBe(88);
  });

  it('3. getPedagogicalArchetype 基于四象限重心矢量准确推导流派', () => {
    // 右上象限：架构深(96) + 源码透(95)，通俗(70)，体系(70)
    const codeDiverAxes = [
      { key: 'depth', label: '架构深度', description: '', value: 96 },
      { key: 'codeFidelity', label: '源码剖析', description: '', value: 95 },
      { key: 'pedagogy', label: '深入浅出', description: '', value: 70 },
      { key: 'coverage', label: '体系全景', description: '', value: 70 },
    ];
    expect(getPedagogicalArchetype(codeDiverAxes).key).toBe('CODE_DIVER');
    expect(getPedagogicalArchetype(codeDiverAxes).label).toBe('深度源码');

    // 左上象限：架构深(96) + 体系全(95)，源码(70)，通俗(70)
    const systemArchAxes = [
      { key: 'depth', label: '架构深度', description: '', value: 96 },
      { key: 'codeFidelity', label: '源码剖析', description: '', value: 70 },
      { key: 'pedagogy', label: '深入浅出', description: '', value: 70 },
      { key: 'coverage', label: '体系全景', description: '', value: 95 },
    ];
    expect(getPedagogicalArchetype(systemArchAxes).key).toBe('SYSTEM_ARCHITECT');
    expect(getPedagogicalArchetype(systemArchAxes).label).toBe('宏观架构');

    // 左下象限：深入浅出(96) + 体系全(95)，架构(70)，源码(70)
    const holisticPrimerAxes = [
      { key: 'depth', label: '架构深度', description: '', value: 70 },
      { key: 'codeFidelity', label: '源码剖析', description: '', value: 70 },
      { key: 'pedagogy', label: '深入浅出', description: '', value: 96 },
      { key: 'coverage', label: '体系全景', description: '', value: 95 },
    ];
    expect(getPedagogicalArchetype(holisticPrimerAxes).key).toBe('HOLISTIC_PRIMER');
    expect(getPedagogicalArchetype(holisticPrimerAxes).label).toBe('通俗入门');

    // 右下象限：深入浅出(96) + 源码透(95)，架构(70)，体系(70)
    const focusedCoreAxes = [
      { key: 'depth', label: '架构深度', description: '', value: 70 },
      { key: 'codeFidelity', label: '源码剖析', description: '', value: 95 },
      { key: 'pedagogy', label: '深入浅出', description: '', value: 96 },
      { key: 'coverage', label: '体系全景', description: '', value: 70 },
    ];
    expect(getPedagogicalArchetype(focusedCoreAxes).key).toBe('FOCUSED_CORE');
    expect(getPedagogicalArchetype(focusedCoreAxes).label).toBe('直击核心');

    // 轴心均衡：全在 85 左右 (分差不超过 6)
    const balancedAxes = [
      { key: 'depth', label: '架构深度', description: '', value: 85 },
      { key: 'codeFidelity', label: '源码剖析', description: '', value: 87 },
      { key: 'pedagogy', label: '深入浅出', description: '', value: 86 },
      { key: 'coverage', label: '体系全景', description: '', value: 84 },
    ];
    expect(getPedagogicalArchetype(balancedAxes).key).toBe('BALANCED');
    expect(getPedagogicalArchetype(balancedAxes).label).toBe('全能综合');
  });

  it('4. compassPoints 正确执行基线截断与长板拉伸，拉大视觉分差', () => {
    // 95 与 60 在基线 50 的拉伸下，比率差距显著
    // 95: (95 - 50)/50 = 0.90
    // 60: (60 - 50)/50 = 0.20
    const pointsStr = compassPoints([95, 60, 50, 75], 100, 50, 50);
    const coords = pointsStr.split(' ').map((p) => p.split(',').map(Number));

    // North (95): y 坐标大幅上移
    expect(coords[0][1]).toBeCloseTo(100 - 50 * 0.9, 1);
    // East (60): x 坐标轻微右移 (50 * 0.2 = 10)
    expect(coords[1][0]).toBeCloseTo(100 + 50 * 0.2, 1);
  });

  it('5. DirectionalDiamondSvg 渲染完整正交十字轴与 4 极标签', () => {
    const axes = [
      { key: 'depth', label: '架构深度', description: '', value: 95 },
      { key: 'codeFidelity', label: '源码剖析', description: '', value: 98 },
      { key: 'pedagogy', label: '深入浅出', description: '', value: 85 },
      { key: 'coverage', label: '体系全景', description: '', value: 82 },
    ];

    const svgHtml = renderToString(
      React.createElement(DirectionalDiamondSvg, {
        axes,
        size: 224,
        showLabels: true,
      })
    );

    expect(svgHtml).toContain('架构深度');
    expect(svgHtml).toContain('95');
    expect(svgHtml).toContain('源码剖析');
    expect(svgHtml).toContain('98');
    expect(svgHtml).toContain('深入浅出');
    expect(svgHtml).toContain('85');
    expect(svgHtml).toContain('体系全景');
    expect(svgHtml).toContain('82');
    // 包含高光长板 (98 最强)
    expect(svgHtml).toContain('animate-pulse');
  });
});
