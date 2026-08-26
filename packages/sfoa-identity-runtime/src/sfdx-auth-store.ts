import { AuthInfo } from '@salesforce/core';
import type { IdentityRuntimeConfig } from './config.js';
import type { JwtOAuthOptions } from './connection-factory.js';

const GENERIC_UNIX_KEYCHAIN_VAR = 'SF_USE_GENERIC_UNIX_KEYCHAIN';

/**
 * Forces `@salesforce/core` to use the file-based `~/.sfdx/key.json` keychain on
 * headless Linux instead of the DBus SecretService. Without it, `Crypto.create()`
 * throws on servers without a running secret service, which makes `orgs.write()`
 * silently no-op and `AuthInfo.save()` never persist — surfacing later as
 * `NamedOrgNotFoundError` in dx-core's internal `AuthInfo.create({ username })`.
 *
 * Idempotent and cheap: call it before any `@salesforce/core` crypto use.
 * Must run before core's first crypto use; safe to call again.
 */
export function ensureGenericUnixKeychain(): void {
  if (process.platform === 'linux' && process.env[GENERIC_UNIX_KEYCHAIN_VAR] === undefined) {
    process.env[GENERIC_UNIX_KEYCHAIN_VAR] = 'true';
  }
}

/**
 * The SF usernames the runtime authenticates for out of environment config:
 * the primary user, the secondary test user, and the diagnostic user.
 * Empty/whitespace values are dropped and duplicates collapsed.
 */
export function configuredSfdxUsernames(config: IdentityRuntimeConfig): readonly string[] {
  const usernames = [config.primaryUsername, config.secondaryUsername, config.diagnosticUsername]
    .filter((username): username is string => Boolean(username?.trim()));
  return Object.freeze([...new Set(usernames)]);
}

export type SfdxAuthStoreDependencies = Readonly<{
  createAuthInfo(options: JwtOAuthOptions): Promise<AuthInfo>;
}>;

const defaultDependencies: SfdxAuthStoreDependencies = {
  createAuthInfo: async (options) => AuthInfo.create({ oauth2Options: options }),
};

export type SfdxAuthStoreSeedResult = Readonly<{
  seeded: readonly string[];
  failed: readonly { username: string; code: string }[];
}>;

/**
 * Pre-populates the SFDX local auth store (`~/.sfdx/<username>.json`) for every
 * configured SF user so dx-core's store lookup (`AuthInfo.create({ username })`)
 * never fails with `NamedOrgNotFoundError`.
 *
 * Each user is authenticated once via the shared JWT credential and the result
 * persisted with `AuthInfo.save()`. Failures are collected and logged per-user —
 * this never throws or blocks service startup, so an unreachable Salesforce at
 * boot degrades to request-time JWT only.
 */
export async function seedSfdxLocalAuthStore(
  config: IdentityRuntimeConfig,
  extraUsernames: readonly string[] = [],
  dependencies: SfdxAuthStoreDependencies = defaultDependencies,
): Promise<SfdxAuthStoreSeedResult> {
  ensureGenericUnixKeychain();
  if (!config.clientId.trim() || !config.privateKeyPath.trim()) {
    return Object.freeze({ seeded: Object.freeze([]), failed: Object.freeze([]) });
  }
  const usernames = [...new Set([...configuredSfdxUsernames(config), ...extraUsernames])]
    .filter((username) => Boolean(username?.trim()));
  const seeded: string[] = [];
  const failed: { username: string; code: string }[] = [];
  for (const username of usernames) {
    try {
      const authInfo = await dependencies.createAuthInfo({
        username,
        clientId: config.clientId,
        privateKeyFile: config.privateKeyPath,
        loginUrl: config.instanceUrl,
      });
      await authInfo.save();
      seeded.push(username);
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'sfoa_auth_store_seed',
        username,
        outcome: 'SEEDED',
      })}\n`);
    } catch (error) {
      const code = error instanceof Error ? error.name : 'UNKNOWN';
      failed.push({ username, code });
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'sfoa_auth_store_seed',
        username,
        outcome: 'FAILED',
        errorCode: code,
      })}\n`);
    }
  }
  return Object.freeze({ seeded: Object.freeze(seeded), failed: Object.freeze(failed) });
}
