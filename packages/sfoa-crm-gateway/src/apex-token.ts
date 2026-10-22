import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';
import { CrmGatewayError } from './errors.js';

/**
 * Salesforce Apex 身份引导凭证的验签器。
 *
 * 信任边界是**固定配置**：
 *   - 只信任部署时钉住的公钥/证书（可选 SHA-256 指纹）；
 *   - 只信任配置的 issuer / audience / 组织；
 *   - 验证算法固定 RSA-SHA256，不做算法协商或降级；
 *   - 不从 token 里的任何 URL 获取公钥。
 *
 * Token 结构：`v1.<base64url(payload JSON)>.<base64url(signature)>`，
 * Apex 对 `v1.<payload>` 的 UTF-8 字节做 `Crypto.sign('RSA-SHA256', ...)`。
 */

const claimsSchema = z.object({
  iss: z.string().min(1).max(128),
  aud: z.string().min(1).max(128),
  orgId: z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u),
  userId: z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u),
  username: z.string().min(1).max(320)
    .refine((value) => value.trim().length > 0)
    .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value)),
  displayName: z.string().min(1).max(255)
    .refine((value) => value.trim().length > 0)
    .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value))
    .optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  jti: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
}).strict();

export type ApexClaims = Readonly<{
  issuer: string;
  audience: string;
  orgId: string;
  userId: string;
  username: string;
  displayName: string;
  issuedAt: Date;
  expiresAt: Date;
  jti: string;
}>;

export type ApexVerifierOptions = Readonly<{
  publicKey: KeyObject;
  issuer: string;
  audience: string;
  allowedOrgIds: readonly string[];
  maxAgeMs: number;
  maxTtlMs: number;
  clockSkewMs: number;
  nowMs?: () => number;
}>;

const MAX_TOKEN_CHARS = 8192;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export class ApexTokenVerifier {
  private readonly allowedOrgIds: ReadonlySet<string>;
  private readonly nowMs: () => number;

  public constructor(private readonly options: ApexVerifierOptions) {
    this.allowedOrgIds = new Set(options.allowedOrgIds.map((id) => id.toUpperCase()));
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  public verify(token: string): ApexClaims {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
      throw invalidToken();
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw invalidToken();
    const [, encodedPayload, encodedSignature] = parts;
    if (!encodedPayload || !encodedSignature || !BASE64URL.test(encodedPayload) || !BASE64URL.test(encodedSignature)) {
      throw invalidToken();
    }

    const payloadBytes = Buffer.from(encodedPayload, 'base64url');
    const signatureBytes = Buffer.from(encodedSignature, 'base64url');
    if (payloadBytes.length === 0 || signatureBytes.length < 64 || signatureBytes.length > 1024) throw invalidToken();

    let signatureValid = false;
    try {
      signatureValid = verifySignature(
        'RSA-SHA256',
        Buffer.from(`v1.${encodedPayload}`, 'utf8'),
        this.options.publicKey,
        signatureBytes,
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) throw invalidSignature();

    let raw: unknown;
    try {
      raw = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
      throw invalidToken();
    }
    const parsed = claimsSchema.safeParse(raw);
    if (!parsed.success) throw invalidToken();
    const claims = parsed.data;

    if (claims.iss !== this.options.issuer) throw invalidToken();
    if (claims.aud !== this.options.audience) throw invalidToken();
    if (!this.allowedOrgIds.has(claims.orgId.toUpperCase())) {
      throw new CrmGatewayError(
        'CRM_APEX_ORG_NOT_ALLOWED',
        '当前 Salesforce 组织未获准使用 CRM 聊天入口。',
        403,
      );
    }

    const nowMs = this.nowMs();
    const issuedAtMs = claims.iat * 1000;
    const expiresAtMs = claims.exp * 1000;
    if (!Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(expiresAtMs)) throw invalidToken();
    if (claims.exp <= claims.iat) throw invalidToken();
    const ttlMs = expiresAtMs - issuedAtMs;
    if (ttlMs > this.options.maxTtlMs) {
      throw new CrmGatewayError('CRM_APEX_TOKEN_TTL_INVALID', '身份引导凭证的有效期超出允许范围。', 400);
    }
    if (issuedAtMs > nowMs + this.options.clockSkewMs) throw invalidToken();
    if (expiresAtMs < nowMs - this.options.clockSkewMs) {
      throw new CrmGatewayError('CRM_APEX_TOKEN_EXPIRED', '身份引导凭证已过期，请刷新页面后重试。', 401);
    }
    if (nowMs - issuedAtMs > this.options.maxAgeMs + this.options.clockSkewMs) {
      throw new CrmGatewayError('CRM_APEX_TOKEN_EXPIRED', '身份引导凭证已超过允许的使用时限，请刷新页面后重试。', 401);
    }

    return Object.freeze({
      issuer: claims.iss,
      audience: claims.aud,
      orgId: claims.orgId.toUpperCase(),
      userId: claims.userId,
      username: claims.username.trim(),
      displayName: (claims.displayName ?? claims.username).trim(),
      issuedAt: new Date(issuedAtMs),
      expiresAt: new Date(expiresAtMs),
      jti: claims.jti.toLowerCase(),
    });
  }
}

/**
 * 读取部署时钉住的公钥。支持 PEM 公钥或 X.509 证书；如果配置了指纹，
 * 必须是证书且指纹逐字节匹配。
 *
 * @param pem
 * @param expectedSha256 证书 DER 的 SHA-256 十六进制（可选）
 */
export function loadApexPublicKey(pem: string, expectedSha256?: string): KeyObject {
  const trimmed = pem.trim();
  if (trimmed.length === 0) throw new Error('The configured Apex public key is empty.');
  if (trimmed.includes('BEGIN CERTIFICATE')) {
    const certificate = new X509Certificate(trimmed);
    if (expectedSha256 !== undefined) {
      const actual = createHash('sha256').update(certificate.raw).digest('hex');
      if (!constantTimeEqualHex(actual, expectedSha256)) {
        throw new Error('The configured Apex certificate SHA-256 does not match the pinned fingerprint.');
      }
    }
    return certificate.publicKey;
  }
  if (expectedSha256 !== undefined) {
    throw new Error('CRM_APEX_CERT_SHA256 requires an X.509 certificate, not a bare public key.');
  }
  return createPublicKey(trimmed);
}

function constantTimeEqualHex(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left.toLocaleLowerCase('en-US'), 'utf8');
  const rightBytes = Buffer.from(right.toLocaleLowerCase('en-US'), 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function invalidToken(): CrmGatewayError {
  return new CrmGatewayError('CRM_APEX_TOKEN_INVALID', '身份引导凭证无效。', 401);
}

function invalidSignature(): CrmGatewayError {
  return new CrmGatewayError('CRM_APEX_SIGNATURE_INVALID', '身份引导凭证签名验证失败。', 401);
}
