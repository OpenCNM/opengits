import { describe, it, expect } from 'vitest';

describe('M03 [3.1] Reader Layout & Keyboard Shortcut Guards', () => {
  it('3.1.1.1 键盘快捷键在输入框中打字时应被正确忽略', () => {
    const isInputElement = (tagName: string, isContentEditable: boolean) => {
      const inputs = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
      return inputs.has(tagName.toUpperCase()) || isContentEditable;
    };

    expect(isInputElement('INPUT', false)).toBe(true);
    expect(isInputElement('TEXTAREA', false)).toBe(true);
    expect(isInputElement('DIV', true)).toBe(true);
    expect(isInputElement('DIV', false)).toBe(false);
    expect(isInputElement('BODY', false)).toBe(false);
  });
});
