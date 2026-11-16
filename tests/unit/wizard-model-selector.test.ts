import { describe, expect, it, beforeEach } from 'vitest';
import {
  getProviderBrand,
  detectModelSeries,
  groupProviderModels,
} from '@/components/ImportWizard/common/WizardModelSelector';
import { setLocale } from '@/paraglide/runtime.js';

describe('WizardModelSelector helper utilities (克制与中性规范)', () => {
  beforeEach(() => {
    setLocale('zh-CN');
  });

  describe('getProviderBrand (仅保留品牌圆点色)', () => {
    it('正确识别智谱 GLM 品牌信息与圆点', () => {
      const brand = getProviderBrand('zhipu');
      expect(brand.name).toBe('智谱 GLM');
      expect(brand.shortName).toBe('智谱');
      expect(brand.dotClass).toBe('bg-purple-500');
    });

    it('正确识别阿里百炼品牌信息与圆点', () => {
      const brand = getProviderBrand('dashscope');
      expect(brand.name).toBe('阿里百炼');
      expect(brand.shortName).toBe('百炼');
      expect(brand.dotClass).toBe('bg-amber-500');
    });

    it('正确识别 DeepSeek 品牌信息与圆点', () => {
      const brand = getProviderBrand('deepseek');
      expect(brand.name).toBe('DeepSeek');
      expect(brand.shortName).toBe('DeepSeek');
      expect(brand.dotClass).toBe('bg-blue-500');
    });

    it('对未知自定义服务商优雅回退中性点', () => {
      const brand = getProviderBrand('my-custom-provider', '我的自建端点');
      expect(brand.name).toBe('我的自建端点');
      expect(brand.shortName).toBe('我的自建');
      expect(brand.dotClass).toBe('bg-theme-muted');
    });
  });

  describe('detectModelSeries (逻辑子系列划分)', () => {
    it('准确识别 DeepSeek 系列', () => {
      const s = detectModelSeries('deepseek-v4.1-flash');
      expect(s.id).toBe('deepseek');
      expect(s.name).toBe('DeepSeek 系列');
    });

    it('准确识别 Qwen 系列', () => {
      const s = detectModelSeries('qwen3.8-max');
      expect(s.id).toBe('qwen');
      expect(s.name).toBe('通义千问 Qwen');
    });

    it('准确识别 GLM 系列', () => {
      const s = detectModelSeries('glm-5.3-flash');
      expect(s.id).toBe('glm');
      expect(s.name).toBe('智谱 GLM 系列');
    });

    it('对通用模型兜底', () => {
      const s = detectModelSeries('custom-finetune-v1');
      expect(s.id).toBe('default');
    });
  });

  describe('groupProviderModels (智能子分组结构)', () => {
    it('当单一系列时无多余子标题', () => {
      const zhipuModels = ['glm-5.3', 'glm-5.2', 'glm-5', 'glm-4-plus', 'glm-5.3-flash'];
      const groups = groupProviderModels(zhipuModels);
      expect(groups.length).toBe(1);
      expect(groups[0].showSubHeader).toBe(false);
      expect(groups[0].models.length).toBe(5);
    });

    it('当阿里百炼混合 Qwen 和 DeepSeek 时自动拆分子系列并展示微细子标题', () => {
      const bailianModels = [
        'qwen3.8-max',
        'qwen3.8-27b',
        'qwen3.6-flash',
        'qwen-max-latest',
        'qwen-plus-latest',
        'qwen3.8-flash',
        'deepseek-v4.1-flash',
      ];
      const groups = groupProviderModels(bailianModels);
      expect(groups.length).toBe(2);
      expect(groups[0].showSubHeader).toBe(true);
      expect(groups[0].seriesId).toBe('qwen');
      expect(groups[0].models.length).toBe(6);

      expect(groups[1].showSubHeader).toBe(true);
      expect(groups[1].seriesId).toBe('deepseek');
      expect(groups[1].models.length).toBe(1);
      expect(groups[1].models[0]).toBe('deepseek-v4.1-flash');
    });
  });
});
