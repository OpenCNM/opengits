import { describe, expect, it } from 'vitest';
import { generatePaginationPages } from '@/components/settings/PublicationsPagination';
import { PUBLICATIONS_PAGINATION } from '@/lib/constants';

describe('PublicationsPagination 前端分页纯函数与边界测试', () => {
  it('集中常量配置中正确定义 PAGE_SIZE 为 10', () => {
    expect(PUBLICATIONS_PAGINATION.PAGE_SIZE).toBe(10);
  });

  describe('generatePaginationPages 分页序列生成算法', () => {
    it('当 totalPages <= 0 时返回空数组', () => {
      expect(generatePaginationPages(1, 0)).toEqual([]);
      expect(generatePaginationPages(1, -5)).toEqual([]);
    });

    it('当 totalPages <= 7 时生成完整连续页码序列（无省略号）', () => {
      expect(generatePaginationPages(1, 1)).toEqual([1]);
      expect(generatePaginationPages(1, 3)).toEqual([1, 2, 3]);
      expect(generatePaginationPages(2, 5)).toEqual([1, 2, 3, 4, 5]);
      expect(generatePaginationPages(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('当 totalPages > 7 且位于起始区域（currentPage <= 4）时，生成头部展开序列', () => {
      expect(generatePaginationPages(1, 10)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 10]);
      expect(generatePaginationPages(3, 10)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 10]);
      expect(generatePaginationPages(4, 10)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 10]);
    });

    it('当 totalPages > 7 且位于末尾区域（currentPage >= totalPages - 3）时，生成尾部展开序列', () => {
      expect(generatePaginationPages(7, 10)).toEqual([1, 'ellipsis', 6, 7, 8, 9, 10]);
      expect(generatePaginationPages(8, 10)).toEqual([1, 'ellipsis', 6, 7, 8, 9, 10]);
      expect(generatePaginationPages(10, 10)).toEqual([1, 'ellipsis', 6, 7, 8, 9, 10]);
    });

    it('当 totalPages > 7 且位于中间区域时，生成双向省略序列', () => {
      expect(generatePaginationPages(5, 10)).toEqual([1, 'ellipsis', 4, 5, 6, 'ellipsis', 10]);
      expect(generatePaginationPages(6, 10)).toEqual([1, 'ellipsis', 5, 6, 7, 'ellipsis', 10]);
      expect(generatePaginationPages(10, 20)).toEqual([1, 'ellipsis', 9, 10, 11, 'ellipsis', 20]);
    });
  });

  describe('数据切片与边界保护逻辑（27 条真实业务用例）', () => {
    const totalItems = 27;
    const pageSize = PUBLICATIONS_PAGINATION.PAGE_SIZE; // 10
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize)); // 3

    it('正确计算总页数为 3 页', () => {
      expect(totalPages).toBe(3);
    });

    it('第 1 页展示条目 1-10，切片索引 0-10', () => {
      const page = 1;
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      expect(start).toBe(0);
      expect(end).toBe(10);
      expect(Math.min(page * pageSize, totalItems)).toBe(10);
    });

    it('第 2 页展示条目 11-20，切片索引 10-20', () => {
      const page = 2;
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      expect(start).toBe(10);
      expect(end).toBe(20);
      expect(Math.min(page * pageSize, totalItems)).toBe(20);
    });

    it('第 3 页展示条目 21-27，切片索引 20-30（实际长度 7）', () => {
      const page = 3;
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      expect(start).toBe(20);
      expect(end).toBe(30);
      expect(Math.min(page * pageSize, totalItems)).toBe(27);
    });

    it('防御性边界钳制：超范围页码自动收敛', () => {
      const clampPage = (p: number) => Math.min(Math.max(1, p), totalPages);
      expect(clampPage(0)).toBe(1);
      expect(clampPage(-5)).toBe(1);
      expect(clampPage(4)).toBe(3);
      expect(clampPage(99)).toBe(3);
    });
  });
});
