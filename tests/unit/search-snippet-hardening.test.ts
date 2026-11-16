import { describe, it, expect } from 'vitest';
import { extractContextSnippet, resolveDocTitle } from '@/lib/search/snippet';

describe('Search Snippet & Title Resolution Hardening', () => {
  describe('extractContextSnippet', () => {
    it('strips YAML frontmatter strictly anchored at start without stripping internal horizontal rules', () => {
      const docWithDividers = `
Section One Introduction
---
Section Two with target keyword authorization and permissions
---
Section Three Conclusion
`.trim();

      const snippet = extractContextSnippet(docWithDividers, 'authorization');
      expect(snippet).toContain('authorization');
      expect(snippet).toContain('permissions');
    });

    it('strips frontmatter at document start when present', () => {
      const docWithFrontmatter = `---
title: My Guide
author: Team
date: 2026-01-01
---
Welcome to our system documentation. Here is information about authentication.`;

      // Without query, returns snippet starting at real content start
      const startSnippet = extractContextSnippet(docWithFrontmatter, '');
      expect(startSnippet).not.toContain('title: My Guide');
      expect(startSnippet).not.toContain('author: Team');
      expect(startSnippet).toContain('Welcome to our system documentation');

      // With query, centers on keyword without frontmatter leaking
      const snippet = extractContextSnippet(docWithFrontmatter, 'authentication');
      expect(snippet).not.toContain('title: My Guide');
      expect(snippet).toContain('authentication');
    });

    it('strips both backtick (```) and tilde (~~~) code blocks from snippets', () => {
      const docWithCode = `
Introduction to the API.

\`\`\`typescript
const token = 'xyz'; // should not be in snippet
\`\`\`

~~~bash
curl -H "Auth: none" https://api.example.com
~~~

Follow the deployment checklist for authentication setup.
`;

      const snippet = extractContextSnippet(docWithCode, 'deployment');
      expect(snippet).not.toContain('curl');
      expect(snippet).not.toContain('const token');
      expect(snippet).toContain('deployment checklist');
    });

    it('centers snippet around query keyword and provides ellipses', () => {
      const longText = 'A'.repeat(50) + ' keyword ' + 'B'.repeat(50);
      const snippet = extractContextSnippet(longText, 'keyword', 60);
      expect(snippet).toContain('keyword');
      expect(snippet.startsWith('...')).toBe(true);
      expect(snippet.endsWith('...')).toBe(true);
    });

    it('preserves snake_case identifiers and colons in snippets without breaking keyword match', () => {
      const doc = 'Welcome. Call get_user_profile(user_id) to fetch the details. Note: tokens expire in 1 hour.';
      const snippet1 = extractContextSnippet(doc, 'get_user_profile');
      expect(snippet1).toContain('get_user_profile');
      expect(snippet1).toContain('user_id');
      expect(snippet1).toContain('Note:');

      const snippet2 = extractContextSnippet(doc, 'user_id');
      expect(snippet2).toContain('user_id');
    });
  });

  describe('resolveDocTitle', () => {
    it('uses explicit title and cleans markdown heading syntax', () => {
      expect(resolveDocTitle('# Getting Started')).toBe('Getting Started');
      expect(resolveDocTitle('### Installation Guide')).toBe('Installation Guide');
    });

    it('ignores code comments (# comment) inside code blocks when finding H1 title', () => {
      const contentWithPythonCode = `
\`\`\`python
# This is a python comment, not a title
import os
import sys
\`\`\`

# Actual Document Title

This is the document body.
`;

      const title = resolveDocTitle('', null, contentWithPythonCode);
      expect(title).toBe('Actual Document Title');
    });

    it('ignores bash comments (# comment) inside tilde code blocks', () => {
      const contentWithBash = `
~~~bash
# Shell comment here
export NODE_ENV=production
~~~

# Production Deployment Guide
`;

      const title = resolveDocTitle(null, null, contentWithBash);
      expect(title).toBe('Production Deployment Guide');
    });

    it('ignores YAML frontmatter comments when extracting document title', () => {
      const docWithYamlComments = `---
title: ""
description: "Frontmatter with comments"
# This is a YAML comment, NOT a doc title
author: developer
---

# Real Section Title

Doc contents.
`;
      const title = resolveDocTitle('', null, docWithYamlComments);
      expect(title).toBe('Real Section Title');
    });

    it('derives title from file path if title and heading are missing', () => {
      expect(resolveDocTitle('', 'docs/user-account-settings.mdx', '')).toBe('User account settings');
      expect(resolveDocTitle(null, 'guide/api_reference.md', null)).toBe('Api reference');
      expect(resolveDocTitle(null, 'guide/intro.markdown', null)).toBe('Intro');
    });

    it('falls back to default fallback when nothing is provided', () => {
      expect(resolveDocTitle('', '', '')).toBe('未命名文档');
    });
  });
});
