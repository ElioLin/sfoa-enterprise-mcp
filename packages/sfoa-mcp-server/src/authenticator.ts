import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHeaders } from '@sfoa/identity-runtime';
import { RemoteRuntimeError } from './errors.js';

export type AuthenticatedClient = Readonly<{
  clientId: string;
}>;

export interface ClientAuthenticator {
  authenticate(headers: RequestHeaders): AuthenticatedClient;
}

export class InternalBearerAuthenticator implements ClientAuthenticator {
  private readonly expectedDigest: Buffer;

  public constructor(token: string) {
    if (token.length === 0) {
      throw new RemoteRuntimeError(
        'MCP_RUNTIME_CONFIGURATION_INVALID',
        'MCP_CLIENT_TOKEN must be configured when internal Bearer authentication is enabled.',
      );
    }
    this.expectedDigest = digest(token);
  }

  public authenticate(headers: RequestHeaders): AuthenticatedClient {
    const authorization = getSingleHeader(headers, 'authorization');
    if (authorization === undefined || authorization.trim().length === 0) {
      throw new RemoteRuntimeError(
        'MCP_CLIENT_AUTH_REQUIRED',
        'Authorization: Bearer credentials are required for this MCP endpoint.',
      );
    }

    const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization.trim());
    if (!match?.[1] || !timingSafeEqual(this.expectedDigest, digest(match[1]))) {
      throw new RemoteRuntimeError(
        'MCP_CLIENT_AUTH_INVALID',
        'The MCP client Bearer credential is invalid.',
      );
    }

    return Object.freeze({ clientId: 'internal-bearer' });
  }
}

export class DisabledLoopbackAuthenticator implements ClientAuthenticator {
  public authenticate(_headers: RequestHeaders): AuthenticatedClient {
    return Object.freeze({ clientId: 'development-loopback' });
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function getSingleHeader(headers: RequestHeaders, targetName: string): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLocaleLowerCase('en-US') === targetName);
  const value = entry?.[1];
  if (typeof value === 'string' || value === undefined) return value;
  return value.length === 1 ? value[0] : undefined;
}
