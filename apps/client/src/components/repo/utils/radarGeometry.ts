import * as m from '@/paraglide/messages';

export interface RadarAxis {
  key: string;
  label: string;
  description: string;
  comment?: string;
  /** 0-100；null = 暂缺（轴置灰） */
  value: number | null;
  /** 四向罗盘方位：'north' | 'east' | 'south' | 'west' */
  direction?: 'north' | 'east' | 'south' | 'west';
}

/** 四向正交坐标轴：北(架构) -> 东(源码) -> 南(通俗) -> 西(全景) */
export const AXES_ORDER = [
  'depth',
  'codeFidelity',
  'pedagogy',
  'coverage',
] as const;

export type AxisKey = (typeof AXES_ORDER)[number];

export function getAxisConfig(): Record<
  AxisKey,
  { label: string; description: string; direction: 'north' | 'east' | 'south' | 'west' }
> {
  return {
    depth: {
      label: m.radar_axis_depth(),
      description: m.radar_axis_depth_desc(),
      direction: 'north',
    },
    codeFidelity: {
      label: m.radar_axis_code_fidelity(),
      description: m.radar_axis_code_fidelity_desc(),
      direction: 'east',
    },
    pedagogy: {
      label: m.radar_axis_pedagogy(),
      description: m.radar_axis_pedagogy_desc(),
      direction: 'south',
    },
    coverage: {
      label: m.radar_axis_coverage(),
      description: m.radar_axis_coverage_desc(),
      direction: 'west',
    },
  };
}

/** 四向矛头罗盘：基线截断与动态对比度加权，放大长板与差异 */
export function compassPoints(
  values: Array<number | null>,
  center: number,
  radius: number,
  baseline = 50
): string {
  return values
    .map((v, i) => {
      const angle = (Math.PI * 2 * i) / values.length - Math.PI / 2;
      const val = v != null ? Math.max(0, Math.min(100, v)) : 0;
      const ratio =
        val > 0
          ? Math.max(0.18, Math.min(1.0, (Math.max(baseline, val) - baseline) / (100 - baseline)))
          : 0;
      const r = radius * ratio;
      return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`;
    })
    .join(' ');
}
