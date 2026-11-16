import { describe, it, expect } from 'vitest';
import { parseGithubUrl } from '../../apps/client/src/lib/url-parser';
import { inspectGithubUrl, isPrivateOrLoopbackHost } from '../../apps/client/src/lib/url-inspector';

describe('M01 [1.1] URL Parser & Security Checks', () => {
  it('1.1.1.1 SSRF 内网 IP 与云元数据探测拦截', () => {
    expect(isPrivateOrLoopbackHost('localhost')).toBe(true);
    expect(isPrivateOrLoopbackHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHost('169.254.169.254')).toBe(true);
    expect(isPrivateOrLoopbackHost('10.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHost('192.168.1.1')).toBe(true);
    expect(isPrivateOrLoopbackHost('172.16.0.5')).toBe(true);
    expect(isPrivateOrLoopbackHost('::1')).toBe(true);

    const res = inspectGithubUrl('http://169.254.169.254/latest/meta-data');
    expect(res.isValid).toBe(false);
    expect(res.diagnosticTitle).toContain('禁止访问内网或回环地址');
  });

  it('1.1.1.2 Basic Auth 账号密码脱敏', () => {
    const parsed = parseGithubUrl('https://user:secret-token@github.com/facebook/react');
    expect(parsed).not.toBeNull();
    expect(parsed?.owner).toBe('facebook');
    expect(parsed?.repo).toBe('react');
  });

  it('1.1.1.3 超长 URL 与特殊空字节截断防护', () => {
    const longUrl = 'https://github.com/facebook/' + 'a'.repeat(3000);
    expect(parseGithubUrl(longUrl)).toBeNull();

    const nullByteUrl = 'https://github.com/facebook/react\0.git';
    const parsed = parseGithubUrl(nullByteUrl);
    expect(parsed).not.toBeNull();
    expect(parsed?.repo).toBe('react');
  });

  it('1.1.1.4 路径穿越与伪造域名防护', () => {
    expect(parseGithubUrl('https://github.com/../evil')).toBeNull();
    expect(parseGithubUrl('https://github.com.attacker.com/foo/bar')).toBeNull();
  });
});
