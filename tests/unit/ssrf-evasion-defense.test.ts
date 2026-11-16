import { describe, it, expect } from 'vitest';
import {
  isPrivateOrLoopbackHost,
  isPublicHttpEndpoint,
  inspectGithubUrl,
} from '@/lib/url-inspector';

describe('SSRF Evasion Protection & Host Inspection', () => {
  describe('isPrivateOrLoopbackHost encoding evasion bypasses', () => {
    it('blocks decimal integer IPs', () => {
      // 127.0.0.1 in decimal = 2130706433
      expect(isPrivateOrLoopbackHost('2130706433')).toBe(true);
      // 10.0.0.1 in decimal = 167772161
      expect(isPrivateOrLoopbackHost('167772161')).toBe(true);
      // 192.168.1.1 in decimal = 3232235777
      expect(isPrivateOrLoopbackHost('3232235777')).toBe(true);
      // 169.254.169.254 in decimal = 2852039166
      expect(isPrivateOrLoopbackHost('2852039166')).toBe(true);
    });

    it('blocks hexadecimal IP representations', () => {
      // 0x7f000001 = 127.0.0.1
      expect(isPrivateOrLoopbackHost('0x7f000001')).toBe(true);
      expect(isPrivateOrLoopbackHost('0x7f.0.0.1')).toBe(true);
      expect(isPrivateOrLoopbackHost('0x7f.1')).toBe(true);
      // 0xa9fea9fe = 169.254.169.254
      expect(isPrivateOrLoopbackHost('0xa9fea9fe')).toBe(true);
      expect(isPrivateOrLoopbackHost('0xa.0.0.1')).toBe(true);
    });

    it('blocks octal IP representations', () => {
      // 0177.0.0.1 = 127.0.0.1
      expect(isPrivateOrLoopbackHost('0177.0.0.1')).toBe(true);
      expect(isPrivateOrLoopbackHost('0177.1')).toBe(true);
      // 012.0.0.1 = 10.0.0.1
      expect(isPrivateOrLoopbackHost('012.0.0.1')).toBe(true);
      // Single octal integer representation (017700000001 = 127.0.0.1 in octal)
      expect(isPrivateOrLoopbackHost('017700000001')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 loopback and metadata addresses', () => {
      expect(isPrivateOrLoopbackHost('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrLoopbackHost('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateOrLoopbackHost('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateOrLoopbackHost('::ffff:192.168.0.1')).toBe(true);
      // IPv6 hexadecimal notation for IPv4-mapped loopback (7f00:0001 = 127.0.0.1)
      expect(isPrivateOrLoopbackHost('::ffff:7f00:1')).toBe(true);
    });

    it('blocks CGNAT 100.64.0.0/10 cloud internal space', () => {
      expect(isPrivateOrLoopbackHost('100.64.0.1')).toBe(true);
      expect(isPrivateOrLoopbackHost('100.100.100.100')).toBe(true);
      expect(isPrivateOrLoopbackHost('100.127.255.254')).toBe(true);
    });

    it('blocks single-label hostnames (internal network service discovery)', () => {
      expect(isPrivateOrLoopbackHost('metadata')).toBe(true);
      expect(isPrivateOrLoopbackHost('vault')).toBe(true);
      expect(isPrivateOrLoopbackHost('consul')).toBe(true);
      expect(isPrivateOrLoopbackHost('redis')).toBe(true);
      expect(isPrivateOrLoopbackHost('docker')).toBe(true);
    });

    it('allows valid public IP addresses and domain names', () => {
      expect(isPrivateOrLoopbackHost('8.8.8.8')).toBe(false);
      expect(isPrivateOrLoopbackHost('1.1.1.1')).toBe(false);
      expect(isPrivateOrLoopbackHost('github.com')).toBe(false);
      expect(isPrivateOrLoopbackHost('raw.githubusercontent.com')).toBe(false);
      expect(isPrivateOrLoopbackHost('api.openai.com')).toBe(false);
    });
  });

  describe('isPublicHttpEndpoint SSRF validation', () => {
    it('approves legitimate public endpoints', () => {
      expect(isPublicHttpEndpoint('https://api.openai.com/v1/chat/completions')).toBe(true);
      expect(isPublicHttpEndpoint('https://api.deepseek.com/v1')).toBe(true);
      expect(isPublicHttpEndpoint('http://93.184.216.34')).toBe(true);
    });

    it('rejects loopback and private evasion URLs', () => {
      expect(isPublicHttpEndpoint('http://127.0.0.1:8000/api')).toBe(false);
      expect(isPublicHttpEndpoint('http://localhost:3000')).toBe(false);
      expect(isPublicHttpEndpoint('http://2130706433/')).toBe(false);
      expect(isPublicHttpEndpoint('http://0x7f000001:80/')).toBe(false);
      expect(isPublicHttpEndpoint('http://[::1]:8080/')).toBe(false);
      expect(isPublicHttpEndpoint('http://metadata/latest')).toBe(false);
      expect(isPublicHttpEndpoint('ftp://api.openai.com/')).toBe(false);
    });
  });

  describe('inspectGithubUrl reserved namespaces & gists', () => {
    it('intercepts GitHub reserved namespaces with friendly diagnostic', () => {
      const orgsRes = inspectGithubUrl('https://github.com/orgs/my-org/teams');
      expect(orgsRes.isValid).toBe(false);
      expect(orgsRes.status).toBe('UNSUPPORTED_RESOURCE');
      expect(orgsRes.diagnosticTitle).toContain('系统保留路径');

      const settingsRes = inspectGithubUrl('https://github.com/settings/profile');
      expect(settingsRes.isValid).toBe(false);
      expect(settingsRes.status).toBe('UNSUPPORTED_RESOURCE');

      const exploreRes = inspectGithubUrl('https://github.com/explore');
      expect(exploreRes.isValid).toBe(false);
      expect(exploreRes.status).toBe('UNSUPPORTED_RESOURCE');

      const pullsRes = inspectGithubUrl('https://github.com/pulls');
      expect(pullsRes.isValid).toBe(false);
      expect(pullsRes.status).toBe('UNSUPPORTED_RESOURCE');
    });

    it('intercepts gist.github.com URLs with friendly diagnostic', () => {
      const gistRes = inspectGithubUrl('https://gist.github.com/torvalds/123456');
      expect(gistRes.isValid).toBe(false);
      expect(gistRes.status).toBe('UNSUPPORTED_RESOURCE');
      expect(gistRes.diagnosticTitle).toContain('Gist');
    });

    it('intercepts incomplete raw.githubusercontent.com URLs', () => {
      const incompleteRes = inspectGithubUrl('https://raw.githubusercontent.com/owner/repo');
      expect(incompleteRes.isValid).toBe(false);
      expect(incompleteRes.status).toBe('INVALID_FORMAT');
      expect(incompleteRes.diagnosticTitle).toContain('缺少分支或文件路径');
    });

    it('respects ?ref= override parameter in inspectGithubUrl', () => {
      const res = inspectGithubUrl('https://github.com/owner/repo/blob/main/docs/guide.md?ref=develop');
      expect(res.isValid).toBe(true);
      expect(res.branch).toBe('develop');
    });
  });
});
