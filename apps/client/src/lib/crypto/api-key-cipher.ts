/**
 * BYOK API Key 静态加密（AES-256-GCM，node:crypto 内置，零第三方依赖）。
 *
 * 威胁模型：防数据库拖库 / 备份泄露（at-rest encryption）。密文落库，明文仅在
 * 三个受控出口短暂出现：解密租用端点（lease）、服务端 LLM 调用、用户本机
 * localStorage（用户自己的 key 存自己的机器，v1 接受）。
 *
 * 主密钥纪律：与 NEXTAUTH_SECRET 同款 fail-fast——生产环境缺 BYOK_ENC_KEY
 * 直接抛错拒绝启动，非生产回退显式 insecure 标记的开发兜底。
 *
 * 密文格式：`enc:v1:<iv b64>:<tag b64>:<ciphertext b64>`。
 * 解密兼容明文历史数据（迁移过渡期：读到非 enc:v1: 前缀原样返回）；
 * 存量明文行无需专门迁移——下一次经 model-providers 路由保存该 provider 时
 * 即被 encryptApiKey 幂等洗成密文。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { resolveSecret } from '../secrets';

const ENC_PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (!cachedKey) {
    // 主密钥长度不定（用户自定义 env），统一派生为 32 字节 AES-256 密钥
    const master = resolveSecret(
      'BYOK_ENC_KEY',
      'insecure_dev_byok_enc_key_DO_NOT_USE_IN_PRODUCTION'
    );
    cachedKey = createHash('sha256').update(master).digest();
  }
  return cachedKey;
}

/** 该值是否已是加密存储格式（幂等迁移与解密前置判定共用） */
export function isEncryptedApiKey(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/** 掩码展示（客户端唯一可见形态）：保留首尾片段供人工辨认 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 5)}••••••••••••${trimmed.slice(-4)}`;
}

/** 明文 → `enc:v1:...` 密文。已是密文的输入原样返回（幂等）。 */
export function encryptApiKey(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (isEncryptedApiKey(plaintext)) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * 密文 → 明文。历史明文行（无 enc:v1: 前缀）原样返回，保证迁移过渡期读写不中断；
 * 解密失败（密钥轮换后遗留旧密文）抛错由调用方决定兜底策略，绝不静默返回密文当明文用。
 */
export function decryptApiKey(stored: string): string {
  if (!stored) return stored;
  if (!isEncryptedApiKey(stored)) return stored;
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('[api-key-cipher] malformed ciphertext: expected iv:tag:ct segments');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const ivBuf = Buffer.from(ivB64, 'base64');
  const tagBuf = Buffer.from(tagB64, 'base64');

  if (ivBuf.length !== IV_BYTES) {
    throw new Error('[api-key-cipher] malformed ciphertext: invalid iv length');
  }
  if (tagBuf.length !== TAG_BYTES) {
    throw new Error('[api-key-cipher] malformed ciphertext: invalid auth tag length');
  }

  try {
    const decipher = createDecipheriv(ALGO, masterKey(), ivBuf);
    decipher.setAuthTag(tagBuf);
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      '[api-key-cipher] decrypt failed (auth tag mismatch or key rotation without re-encrypt)'
    );
  }
}

/** 解密但不抛错：无法解密时返回 null，供展示类调用方降级为"已配置但不可用" */
export function tryDecryptApiKey(stored: string): string | null {
  try {
    return decryptApiKey(stored);
  } catch {
    return null;
  }
}

export { sanitizeLogPayload } from './sanitize-log-payload';
