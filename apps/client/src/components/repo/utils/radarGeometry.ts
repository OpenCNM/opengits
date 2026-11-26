import * as m from '@/paraglide/messages';

export interface RadarAxis {
  key: string;
  label: string;
  description: string;
  comment?: string;
  value: number | null;
  direction?: 'north' | 'east' | 'south' | 'west';
}

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
