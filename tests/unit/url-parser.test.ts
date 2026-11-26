import { test, expect, describe, it } from 'vitest';
import { parseGithubUrl } from '@/lib/url-parser';
import { ENGINE_CONFIG } from '@/lib/config';
import { inspectGithubUrl, isPrivateOrLoopbackHost, isPublicHttpEndpoint } from '@/lib/url-inspector';

describe('url-parser & ssrf-evasion-defense', () => {
  test('parseGithubUrl: 短语法 / SSH / git:// / HTTPS / blob / tree / raw.githubusercontent', () => {
    expect(parseGithubUrl('facebook/react')).toEqual({
      owner: 'facebook',
      repo: 'react',
      branch: ENGINE_CONFIG.defaultBranch,
      filePath: null,
      isBlobUrl: false,
      rawUrl: 'facebook/react',
    });
    expect(parseGithubUrl('vercel/next.js.git')).toMatchObject({ owner: 'vercel', repo: 'next.js' });
    expect(parseGithubUrl('git@github.com:torvalds/linux.git')).toMatchObject({ owner: 'torvalds', repo: 'linux', filePath: null });
    expect(parseGithubUrl('git://github.com/expressjs/express.git')).toMatchObject({ owner: 'expressjs', repo: 'express' });
    expect(parseGithubUrl('https://github.com/vuejs/core')).toMatchObject({ owner: 'vuejs', repo: 'core', isBlobUrl: false });
    expect(parseGithubUrl('https://github.com/owner/repo/blob/release-v2/docs/getting-started.md')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'release-v2',
      filePath: 'docs/getting-started.md',
      isBlobUrl: true,
      rawUrl: 'https://github.com/owner/repo/blob/release-v2/docs/getting-started.md',
    });
    expect(parseGithubUrl('https://github.com/owner/repo/tree/develop/packages/core')).toMatchObject({
      branch: 'develop',
      filePath: 'packages/core',
      isBlobUrl: false,
    });
    expect(parseGithubUrl('https://raw.githubusercontent.com/facebook/react/main/packages/react/package.json')).toMatchObject({
      owner: 'facebook',
      repo: 'react',
      branch: 'main',
      filePath: 'packages/react/package.json',
      isBlobUrl: true,
    });
  });

  it('parseGithubUrl: 多段分支 / %2F 编码 / ?ref= 覆盖与异常/穿越拒绝', () => {
    expect(parseGithubUrl('https://github.com/facebook/react/blob/feature/hooks-v2/packages/react/src/React.js')).toMatchObject({
      branch: 'feature/hooks-v2',
      filePath: 'packages/react/src/React.js',
    });
    expect(parseGithubUrl('https://github.com/vercel/next.js/tree/release/v15.2.0')).toMatchObject({
      branch: 'release/v15.2.0',
      filePath: null,
    });
    expect(parseGithubUrl('https://github.com/owner/my-repo/blob/feature%2Fcomplex-work/docs/api.md')).toMatchObject({
      branch: 'feature/complex-work',
      filePath: 'docs/api.md',
    });
    expect(parseGithubUrl('https://github.com/owner/repo/blob/main/docs/guide.md?ref=develop')?.branch).toBe('develop');
    expect(parseGithubUrl('https://github.com/owner/repo/blob/main/docs/guide.md?ref=feature%2Fcustom')?.branch).toBe('feature/custom');
    expect(parseGithubUrl('https://github.com/owner/repo/blob/main/docs/guide.md?ref=../../etc/passwd')?.branch).toBe('main');

    expect(parseGithubUrl('https://user:secret-token@github.com/facebook/react')).toMatchObject({ owner: 'facebook', repo: 'react' });
    expect(parseGithubUrl('https://github.com/facebook/react\0.git')?.repo).toBe('react');

    for (const bad of [
      '',
      null as any,
      undefined as any,
      'https://gitlab.com/owner/repo',
      'https://github.com/' + 'a'.repeat(3000),
      'https://github.com/../evil',
      'https://github.com.attacker.com/foo/bar',
      'https://github.com/owner/repo/blob/main/docs/../secrets.env',
      'https://github.com/owner/repo/blob/main/./hidden',
      'settings/profile',
      'https://github.com/explore',
      'https://github.com/marketplace',
    ]) {
      expect(parseGithubUrl(bad), String(bad)).toBeNull();
    }
  });

  it('isPrivateOrLoopbackHost 拦截十进制/十六进制/八进制/IPv4-mapped/CGNAT/单标签内网并放行公网', () => {
    for (const priv of [
      'localhost',
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.5',
      '::1',
      '2130706433',
      '167772161',
      '3232235777',
      '2852039166',
      '0x7f000001',
      '0x7f.0.0.1',
      '0xa9fea9fe',
      '0177.0.0.1',
      '017700000001',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:7f00:1',
      '100.64.0.1',
      '100.127.255.254',
      'metadata',
      'redis',
      'consul',
    ]) {
      expect(isPrivateOrLoopbackHost(priv), priv).toBe(true);
    }

    for (const pub of ['8.8.8.8', '1.1.1.1', 'github.com', 'raw.githubusercontent.com', 'api.openai.com']) {
      expect(isPrivateOrLoopbackHost(pub), pub).toBe(false);
    }
  });

  it('isPublicHttpEndpoint & inspectGithubUrl 端点 SSRF 与保留命名空间/Gist/格式诊断', () => {
    expect(isPublicHttpEndpoint('https://api.openai.com/v1/chat/completions')).toBe(true);
    expect(isPublicHttpEndpoint('http://93.184.216.34')).toBe(true);
    for (const bad of [
      'http://127.0.0.1:8000/api',
      'http://localhost:3000',
      'http://2130706433/',
      'http://0x7f000001:80/',
      'http://[::1]:8080/',
      'http://metadata/latest',
      'ftp://api.openai.com/',
    ]) {
      expect(isPublicHttpEndpoint(bad), bad).toBe(false);
    }

    const metaRes = inspectGithubUrl('http://169.254.169.254/latest/meta-data');
    expect(metaRes.isValid).toBe(false);
    expect(metaRes.diagnosticTitle).toContain('禁止访问内网或回环地址');

    expect(inspectGithubUrl('https://github.com/orgs/my-org/teams')).toMatchObject({ isValid: false, status: 'UNSUPPORTED_RESOURCE' });
    expect(inspectGithubUrl('https://github.com/explore')).toMatchObject({ isValid: false, status: 'UNSUPPORTED_RESOURCE' });
    expect(inspectGithubUrl('https://gist.github.com/torvalds/123456')).toMatchObject({ isValid: false, status: 'UNSUPPORTED_RESOURCE' });
    expect(inspectGithubUrl('https://raw.githubusercontent.com/owner/repo')).toMatchObject({ isValid: false, status: 'INVALID_FORMAT' });
    expect(inspectGithubUrl('https://github.com/owner/repo/blob/main/docs/guide.md?ref=develop')).toMatchObject({
      isValid: true,
      branch: 'develop',
    });
  });
});
