import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { DataRuntimeError } from './errors.js';

/**
 * Resolves the single request-scoped USER Salesforce Connection.
 *
 * Data Tools never build their own authentication and never accept a Salesforce
 * username, token, org, or URL as input: the identity is fixed by the authenticated
 * request route, so exactly one allowed username must exist. Zero or several means the
 * request cannot be served as one deterministic USER and is refused before any
 * Salesforce call is made.
 */
export async function resolveRequestConnection(orgService: OrgService): Promise<Connection> {
  const usernames = [...(await orgService.getAllowedOrgUsernames())];
  const username = usernames[0];
  if (usernames.length !== 1 || username === undefined || username.length === 0) {
    throw new DataRuntimeError(
      'MCP_DATA_IDENTITY_UNAVAILABLE',
      'This Tool requires exactly one request-scoped USER Salesforce identity.',
      { suggestion: 'Retry through an authenticated request whose identity route resolves to one Salesforce user.' },
    );
  }
  return await orgService.getConnection(username);
}
