import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useReaderAppearanceStore } from '@/lib/stores/reader-appearance-store';
import { STORAGE_KEYS } from '@/lib/constants';

describe('useReaderAppearanceStore（阅读器外观与排版状态）', () => {
  const storeMap = new Map<string, string>();

  beforeEach(() => {
    storeMap.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storeMap.get(k) ?? null,
      setItem: (k: string, v: string) => storeMap.set(k, String(v)),
      removeItem: (k: string) => storeMap.delete(k),
      clear: () => storeMap.clear(),
    });
    vi.stubGlobal('document', {
      documentElement: {
        setAttribute: () => {},
        classList: { add: () => {}, remove: () => {} },
      },
      body: {
        setAttribute: () => {},
        classList: { add: () => {}, remove: () => {} },
      },
      cookie: '',
    });
    vi.stubGlobal('window', {
      dispatchEvent: () => true,
    });
    useReaderAppearanceStore.setState({ theme: 'vercel', fontSize: 'medium' });
  });

  it('初始状态为 vercel 亮色与 medium 标准字号', () => {
    const state = useReaderAppearanceStore.getState();
    expect(state.theme).toBe('vercel');
    expect(state.fontSize).toBe('medium');
  });

  it('setTheme 能够切换暗色并在 localStorage 持久化', () => {
    useReaderAppearanceStore.getState().setTheme('dark');

    const state = useReaderAppearanceStore.getState();
    expect(state.theme).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEYS.THEME_PREFERENCE)).toBe('dark');
  });

  it('setFontSize 能够设置并持久化合法字号档位', () => {
    useReaderAppearanceStore.getState().setFontSize('large');

    const state = useReaderAppearanceStore.getState();
    expect(state.fontSize).toBe('large');
    expect(localStorage.getItem(STORAGE_KEYS.FONT_SIZE)).toBe('large');
  });

  it('initAppearance 从 localStorage 正确水合用户偏好', () => {
    localStorage.setItem(STORAGE_KEYS.THEME_PREFERENCE, 'dark');
    localStorage.setItem(STORAGE_KEYS.FONT_SIZE, 'small');

    useReaderAppearanceStore.getState().initAppearance();

    const state = useReaderAppearanceStore.getState();
    expect(state.theme).toBe('dark');
    expect(state.fontSize).toBe('small');
  });

  it('initAppearance 传入非法字号时安全回落为 medium', () => {
    useReaderAppearanceStore.getState().initAppearance('invalid-size');

    const state = useReaderAppearanceStore.getState();
    expect(state.fontSize).toBe('medium');
  });
});
