import { describe, expect, it } from 'vitest';
import { decryptApiKey, encryptApiKey, isEncryptedApiKey, maskApiKey, tryDecryptApiKey } from '@/lib/crypto/api-key-cipher';
import { sanitizeLogPayload } from '@/lib/crypto/sanitize-log-payload';
import { resolveMaintainerUserId } from '@/lib/repository-maintainer';
import { authOptions } from '@/lib/auth-helper';
import { isDeepDiveLayerValue, stripDeepDiveSummaryPrefix } from '@/lib/mdx/deep-dive-normalize';
import { remarkDeepDiveHygiene } from '@/lib/mdx/remark-doc-hygiene';

describe('api-key-cipher & sanitizeLogPayload & nextauth-config', () => {
  it('encryptApiKey / decryptApiKey 往返、幂等、随机 IV、明文兼容与掩码', () => {
    const plain = 'sk-test-1234567890abcdef';
    const sealed = encryptApiKey(plain);
    expect(isEncryptedApiKey(sealed)).toBe(true);
    expect(sealed).not.toContain(plain);
    expect(decryptApiKey(sealed)).toBe(plain);
    expect(encryptApiKey(sealed)).toBe(sealed);
    expect(decryptApiKey('sk-legacy-plaintext')).toBe('sk-legacy-plaintext');

    expect([encryptApiKey(''), decryptApiKey(''), isEncryptedApiKey('')]).toEqual(['', '', false]);
    const a = encryptApiKey('sk-same-input');
    const b = encryptApiKey('sk-same-input');
    expect(a).not.toBe(b);
    expect([decryptApiKey(a), decryptApiKey(b)]).toEqual(['sk-same-input', 'sk-same-input']);

    expect(maskApiKey('sk-1234567890wxyz')).toBe('sk-12••••••••••••wxyz');
    expect(maskApiKey('short')).toBe('••••••••');
    expect(maskApiKey('')).toBe('');
  });

  it('decryptApiKey / tryDecryptApiKey 拒绝篡改 GCM tag 及畸变分段/IV/Tag 长度', () => {
    const sealed = encryptApiKey('sk-secret');
    const parts = sealed.split(':');
    const ct = parts[parts.length - 1];
    const tampered = [...parts.slice(0, -1), ct.endsWith('A') ? ct.slice(0, -1) + 'B' : ct.slice(0, -1) + 'A'].join(':');
    expect(() => decryptApiKey(tampered)).toThrow();
    expect(tryDecryptApiKey(tampered)).toBeNull();

    expect(() => decryptApiKey('enc:v1:onlyonepart')).toThrow('malformed ciphertext: expected iv:tag:ct segments');
    expect(() => decryptApiKey('enc:v1:two:parts')).toThrow('malformed ciphertext: expected iv:tag:ct segments');

    const validTagB64 = Buffer.alloc(16).toString('base64');
    const ctB64 = Buffer.from('hello').toString('base64');
    expect(() => decryptApiKey(`enc:v1:${Buffer.from('12345678').toString('base64')}:${validTagB64}:${ctB64}`)).toThrow('invalid iv length');
    expect(() =>
      decryptApiKey(`enc:v1:${Buffer.alloc(12).toString('base64')}:${Buffer.from('123456789012').toString('base64')}:${ctB64}`)
    ).toThrow('invalid auth tag length');
  });

  it('sanitizeLogPayload 敏感字段脱敏、内联 key 替换与循环引用防御', async () => {
    const reexported = (await import('@/lib/crypto/api-key-cipher')).sanitizeLogPayload;
    expect(reexported({ apiKey: 'sk-1234567890abcdef123', provider: 'openai' })).toEqual({ apiKey: '[REDACTED]', provider: 'openai' });

    const sanitized = sanitizeLogPayload({
      name: 'test-model',
      apiKey: 'sk-1234567890abcdef123456',
      nested: { token: 'ghp_abcdefghijklmnopqrstuvwxyz123456', secret: 'my-secret-key', authorization: 'Bearer secret_token_xyz' },
      normalField: 'hello',
    });
    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.nested).toEqual({ token: '[REDACTED]', secret: '[REDACTED]', authorization: '[REDACTED]' });
    expect(sanitized.normalField).toBe('hello');

    expect(sanitizeLogPayload('Failed to connect: sk-abcdef1234567890abcdef invalid')).toBe('Failed to connect: [REDACTED] invalid');

    const circular: any = { name: 'circular' };
    circular.self = circular;
    expect(sanitizeLogPayload(circular)).toEqual({ name: 'circular', self: '[CIRCULAR]' });
  });

  it('NextAuth 配置与维护者身份解析（禁免密凭证登录 + jwt accessToken 映射）', async () => {
    expect(typeof resolveMaintainerUserId).toBe('function');
    expect(authOptions.providers.filter((p) => p.type === 'credentials')).toHaveLength(0);
    const jwtCallback = authOptions.callbacks?.jwt;
    expect(jwtCallback).toBeDefined();
    const token = await jwtCallback!({
      token: {},
      user: { id: 'test-user', email: 'test@example.com', name: 'Test' } as any,
      account: { access_token: 'gho_new_token', provider: 'github' } as any,
    });
    expect([token.accessToken, token.sub]).toEqual(['gho_new_token', 'test-user']);
  });

  it('deep-dive 归一：兼容翻译漂移 data-layer 并统一剥离泛化 summary 前缀', () => {
    const layerCases: Array<[string | null | undefined, boolean]> = [
      ['deep', true],
      ['深挖', true],
      ['deep-dive', true],
      ['源码深潜', true],
      ['main', false],
      ['', false],
      [null, false],
    ];
    for (const [val, want] of layerCases) {
      expect(isDeepDiveLayerValue(val)).toBe(want);
    }

    const prefixCases: Array<[string, string]> = [
      ['深入一步：异步装配入口的迁移与信任读取', '异步装配入口的迁移与信任读取'],
      ['深入细节：订阅意图的串行化收敛', '订阅意图的串行化收敛'],
      ['进阶：会话事件序列与去重窗口', '会话事件序列与去重窗口'],
      ['深挖：日志读取前的前置检查——航班等待与失败短路', '日志读取前的前置检查——航班等待与失败短路'],
      ['深入：WAF 页面与不可渲染错误', 'WAF 页面与不可渲染错误'],
      ['源码深潜：内部状态机', '内部状态机'],
      ['Deep Dive: Internal Buffer Layout', 'Internal Buffer Layout'],
      ['日志分级与重试节奏：为什么普通读取只留开发态调试输出', '日志分级与重试节奏：为什么普通读取只留开发态调试输出'],
      ['同级的迁移辅助：reconcileLegacy', '同级的迁移辅助：reconcileLegacy'],
      ['深入剖析', '深入剖析'],
    ];
    for (const [input, want] of prefixCases) {
      expect(stripDeepDiveSummaryPrefix(input)).toBe(want);
    }

    // AST 读侧投影验证：翻译漂移 data-layer="深挖" 归一为 deep，summary 剥离前缀，标题降级并计数
    const tree: any = {
      type: 'root',
      children: [
        {
          type: 'mdxJsxFlowElement',
          name: 'details',
          attributes: [{ type: 'mdxJsxAttribute', name: 'data-layer', value: '深挖' }],
          children: [
            {
              type: 'mdxJsxFlowElement',
              name: 'summary',
              attributes: [],
              children: [{ type: 'text', value: '深挖：投影内部的事务化 Map' }],
            },
            {
              type: 'heading',
              depth: 3,
              children: [{ type: 'text', value: '回滚细节' }],
            },
          ],
        },
      ],
    };
    const file = { data: {} as Record<string, unknown> };
    remarkDeepDiveHygiene()(tree, file);
    expect(file.data.deepDiveCount).toBe(1);
    expect(tree.children[0].attributes[0].value).toBe('deep');
    expect(tree.children[0].children[0].children[0].value).toBe('投影内部的事务化 Map');
    expect(tree.children[0].children[1].type).toBe('paragraph');
  });
});
