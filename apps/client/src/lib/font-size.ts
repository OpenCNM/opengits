import { DEFAULT_FONT_SIZE, FONT_SIZE_OPTIONS, STORAGE_KEYS, type FontSizeOption } from '@/lib/constants';

/**
 * 校验任意来源（cookie / localStorage / 用户偏好接口）的字号值，非法值回落默认档。
 * 服务端（RootLayout）与客户端共用，保证两端对同一偏好的解释一致。
 */
export function resolveFontSize(raw: unknown): FontSizeOption {
  return FONT_SIZE_OPTIONS.includes(raw as FontSizeOption) ? (raw as FontSizeOption) : DEFAULT_FONT_SIZE;
}

/**
 * 应用正文字号档位：切换 html class、写 localStorage 并同步 cookie。
 * cookie 供 RootLayout 在 SSR 时直出 font-size-* class（通过 --reader-prose-font-size
 * 仅作用于文档正文区），保证首帧字号即最终值且不会引发外围侧栏或分栏宽度跳动。
 */
export function applyFontSize(size: FontSizeOption): void {
  if (typeof document === 'undefined') return;
  const next = resolveFontSize(size);
  const html = document.documentElement;
  html.classList.remove(...FONT_SIZE_OPTIONS.map((s) => `font-size-${s}`));
  html.classList.add(`font-size-${next}`);
  try {
    localStorage.setItem(STORAGE_KEYS.FONT_SIZE, next);
    document.cookie = `${STORAGE_KEYS.FONT_SIZE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  } catch { /* 存储不可用时仅保留本次会话内的 class 生效 */ }
}
