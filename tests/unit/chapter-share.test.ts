import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ChapterShareButton, detectActiveHeadingAnchor } from '@/components/docs/ChapterShareButton';
import { GuestShelfJoinCallout } from '@/components/docs/GuestShelfJoinCallout';
import { setLocale } from '@/paraglide/runtime.js';

describe('ChapterShareButton (极简章节分享按钮与锚点感知)', () => {
  it('正确渲染分享按钮及文本', () => {
    setLocale('zh-CN');
    const html = renderToString(
      React.createElement(ChapterShareButton, {
        title: '01. 核心架构与设计哲学',
        isPublic: true,
      })
    );

    expect(html).toContain('分享');
    expect(html).toContain('cursor-pointer');
    expect(html).toContain('select-none');
  });

  it('英文环境下渲染 Share 文案', () => {
    setLocale('en');
    const html = renderToString(
      React.createElement(ChapterShareButton, {
        title: '01. Core Architecture',
        isPublic: true,
      })
    );

    expect(html).toContain('Share');
  });

  it('detectActiveHeadingAnchor 在无真实 DOM 容器或在顶部时不产生误判', () => {
    // SSR / Node 环境下没有真实 window.scrollY 滚动距离，应安全返回 null 或当前 hash
    const anchor = detectActiveHeadingAnchor();
    expect(anchor).toBeNull();
  });
});

describe('GuestShelfJoinCallout (访客阅读与入架转化承接)', () => {
  it('中文环境下正确渲染入架引导与按钮', () => {
    setLocale('zh-CN');
    const html = renderToString(
      React.createElement(GuestShelfJoinCallout, {
        title: '01. 核心架构与设计哲学',
        owner: 'vllm-project',
        repo: 'vllm',
        isPublic: true,
      })
    );

    expect(html).toContain('喜欢这份结构化教程？');
    expect(html).toContain('加入个人书架');
    expect(html).toContain('分享');
    expect(html).toContain('/auth/signin?callbackUrl=');
  });

  it('英文环境下正确渲染英文文案', () => {
    setLocale('en');
    const html = renderToString(
      React.createElement(GuestShelfJoinCallout, {
        title: '01. Core Architecture',
        owner: 'vllm-project',
        repo: 'vllm',
        isPublic: true,
      })
    );

    expect(html).toContain('Enjoying this interactive tutorial?');
    expect(html).toContain('Add to Bookshelf');
    expect(html).toContain('Share');
  });
});
