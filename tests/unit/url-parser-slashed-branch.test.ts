import { describe, it, expect } from 'vitest';
import { parseGithubUrl } from '@/lib/url-parser';

describe('url-parser multi-segment branches and protocol normalization', () => {
  it('handles multi-segment branch namespaces (feature/xxx, release/xxx, fix/xxx, hotfix/xxx)', () => {
    const res1 = parseGithubUrl('https://github.com/facebook/react/blob/feature/hooks-v2/packages/react/src/React.js');
    expect(res1).not.toBeNull();
    expect(res1?.owner).toBe('facebook');
    expect(res1?.repo).toBe('react');
    expect(res1?.branch).toBe('feature/hooks-v2');
    expect(res1?.filePath).toBe('packages/react/src/React.js');
    expect(res1?.isBlobUrl).toBe(true);

    const res2 = parseGithubUrl('https://github.com/vercel/next.js/tree/release/v15.2.0');
    expect(res2).not.toBeNull();
    expect(res2?.owner).toBe('vercel');
    expect(res2?.repo).toBe('next.js');
    expect(res2?.branch).toBe('release/v15.2.0');
    expect(res2?.filePath).toBeNull();
    expect(res2?.isBlobUrl).toBe(false);

    const res3 = parseGithubUrl('https://github.com/torvalds/linux/blob/fix/null-pointer/kernel/sched/core.c');
    expect(res3).not.toBeNull();
    expect(res3?.branch).toBe('fix/null-pointer');
    expect(res3?.filePath).toBe('kernel/sched/core.c');

    const res4 = parseGithubUrl('https://github.com/tailwindlabs/tailwindcss/blob/hotfix/safelist-bug/src/index.js');
    expect(res4).not.toBeNull();
    expect(res4?.branch).toBe('hotfix/safelist-bug');
    expect(res4?.filePath).toBe('src/index.js');

    const res5 = parseGithubUrl('https://github.com/owner/repo/blob/v/2.0.0/docs/readme.md');
    expect(res5).not.toBeNull();
    expect(res5?.branch).toBe('v/2.0.0');
    expect(res5?.filePath).toBe('docs/readme.md');
  });

  it('handles URL-encoded slashes (%2F) in branch names', () => {
    const res = parseGithubUrl('https://github.com/owner/my-repo/blob/feature%2Fcomplex-work/docs/api.md');
    expect(res).not.toBeNull();
    expect(res?.owner).toBe('owner');
    expect(res?.repo).toBe('my-repo');
    expect(res?.branch).toBe('feature/complex-work');
    expect(res?.filePath).toBe('docs/api.md');
    expect(res?.isBlobUrl).toBe(true);

    const resTree = parseGithubUrl('https://github.com/owner/my-repo/tree/release%2F2026.03');
    expect(resTree).not.toBeNull();
    expect(resTree?.branch).toBe('release/2026.03');
    expect(resTree?.filePath).toBeNull();
  });

  it('allows ?ref= query parameter to override branch', () => {
    const res = parseGithubUrl('https://github.com/owner/repo/blob/main/docs/guide.md?ref=develop');
    expect(res).not.toBeNull();
    expect(res?.branch).toBe('develop');
    expect(res?.filePath).toBe('docs/guide.md');

    const resEncoded = parseGithubUrl('https://github.com/owner/repo/blob/main/docs/guide.md?ref=feature%2Fcustom');
    expect(resEncoded).not.toBeNull();
    expect(resEncoded?.branch).toBe('feature/custom');

    // Traversal attempts in ref parameter should be rejected from overriding
    const resEvil = parseGithubUrl('https://github.com/owner/repo/blob/main/docs/guide.md?ref=../../etc/passwd');
    expect(resEvil?.branch).toBe('main');
  });

  it('normalizes raw.githubusercontent.com URLs into blob URLs', () => {
    const rawUrl = 'https://raw.githubusercontent.com/facebook/react/main/packages/react/package.json';
    const res = parseGithubUrl(rawUrl);
    expect(res).not.toBeNull();
    expect(res?.owner).toBe('facebook');
    expect(res?.repo).toBe('react');
    expect(res?.branch).toBe('main');
    expect(res?.filePath).toBe('packages/react/package.json');
    expect(res?.isBlobUrl).toBe(true);
  });

  it('strictly rejects path traversal inside filePath', () => {
    expect(parseGithubUrl('https://github.com/owner/repo/blob/main/docs/../secrets.env')).toBeNull();
    expect(parseGithubUrl('https://github.com/owner/repo/blob/main/../../etc/passwd')).toBeNull();
    expect(parseGithubUrl('https://github.com/owner/repo/blob/main/./hidden')).toBeNull();
  });

  it('rejects GitHub reserved namespaces in both short syntax and full URLs', () => {
    expect(parseGithubUrl('settings/profile')).toBeNull();
    expect(parseGithubUrl('orgs/myteam')).toBeNull();
    expect(parseGithubUrl('https://github.com/settings/profile')).toBeNull();
    expect(parseGithubUrl('https://github.com/explore')).toBeNull();
    expect(parseGithubUrl('https://github.com/pulls')).toBeNull();
    expect(parseGithubUrl('https://github.com/issues')).toBeNull();
    expect(parseGithubUrl('https://github.com/marketplace')).toBeNull();
  });
});
