import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { IdentityCredentialRecord } from './contracts.js';
import { parseEnvFile } from './config.js';
import { ControlPlaneError } from './errors.js';

export const USER_BOUND_TOKEN_PREFIX = 'sfoa_ub1_';
const TOKEN_RANDOM_BYTES = 32;
const IV_BYTES = 12;
const CIPHER_VERSION = 'v1';
const keySchema = z.string().regex(
  /^[A-Za-z0-9_-]{43}$/u,
  'must be an unpadded base64url encoding of exactly 32 random bytes',
);
const tokenSchema = z.string().regex(/^sfoa_ub1_[A-Za-z0-9_-]{43}$/u);

export type GeneratedUserBoundCredential = Readonly<{
  token: string;
  tokenHash: string;
  tokenCiphertext: string;
  tokenLast4: string;
  generatedAt: Date;
}>;

export class IdentityCredentialCipher {
  private readonly key: Buffer;

  public constructor(key: Buffer) {
    if (key.length !== 32) {
      throw credentialConfigurationError('The identity credential encryption key must contain exactly 32 bytes.');
    }
    this.key = Buffer.from(key);
  }

  public generate(identityRouteId: string, generatedAt = new Date()): GeneratedUserBoundCredential {
    const token = `${USER_BOUND_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(identityRouteId));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Object.freeze({
      token,
      tokenHash: hashUserBoundToken(token),
      tokenCiphertext: [CIPHER_VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.'),
      tokenLast4: token.slice(-4),
      generatedAt,
    });
  }

  public decrypt(record: IdentityCredentialRecord): string {
    if (record.credentialType !== 'USER_BOUND' || record.status !== 'ACTIVE' || !record.tokenCiphertext) {
      throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', 'Only an active USER_BOUND credential can be decrypted.');
    }
    try {
      const parts = record.tokenCiphertext.split('.');
      if (parts.length !== 4 || parts[0] !== CIPHER_VERSION || !parts[1] || !parts[2] || !parts[3]) {
        throw new Error('invalid credential ciphertext envelope');
      }
      const iv = Buffer.from(parts[1], 'base64url');
      const tag = Buffer.from(parts[2], 'base64url');
      const encrypted = Buffer.from(parts[3], 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== 16 || encrypted.length === 0) throw new Error('invalid credential ciphertext bounds');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(aad(record.identityRouteId));
      decipher.setAuthTag(tag);
      const token = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      tokenSchema.parse(token);
      const actualHash = Buffer.from(hashUserBoundToken(token), 'ascii');
      const expectedHash = Buffer.from(record.tokenHash, 'ascii');
      if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
        throw new Error('credential token hash mismatch');
      }
      return token;
    } catch (error) {
      throw new ControlPlaneError(
        'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
        'The stored USER_BOUND credential could not be authenticated and decrypted with the configured key.',
        { cause: error },
      );
    }
  }
}

export function hashUserBoundToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function loadIdentityCredentialCipher(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<IdentityCredentialCipher> {
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parseEnvFile(await readFile(path.join(path.resolve(projectRoot), '.env.local'), 'utf8'));
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) throw error;
  }
  const raw = environment.MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY
    ?? fileValues.MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY;
  const parsed = keySchema.safeParse(raw?.trim());
  if (!parsed.success) {
    throw credentialConfigurationError(
      'MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY must be configured as 32 random bytes encoded with unpadded base64url.',
    );
  }
  return new IdentityCredentialCipher(Buffer.from(parsed.data, 'base64url'));
}

function aad(identityRouteId: string): Buffer {
  return Buffer.from(`sfoa:user-bound:${identityRouteId}:v1`, 'utf8');
}

function credentialConfigurationError(message: string): ControlPlaneError {
  return new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
