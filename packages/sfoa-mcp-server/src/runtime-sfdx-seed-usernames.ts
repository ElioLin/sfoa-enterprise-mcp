type DiagnosticUsernameRecord = Readonly<{
  salesforceUsername: string;
}>;

type SfdxSeedRepositories = Readonly<{
  identityRoutes: Readonly<{
    listActiveSalesforceUsernames(): Promise<readonly string[]>;
  }>;
  diagnostic: Readonly<{
    get(): Promise<DiagnosticUsernameRecord | undefined>;
  }>;
}>;

/**
 * Collects the MySQL-owned usernames required by this MCP process's local SFDX
 * auth-store bootstrap. Deliberately preserves duplicates: the shared seeder
 * owns username deduplication together with environment-configured usernames.
 */
export async function loadMySqlSfdxSeedUsernames(
  repositories: SfdxSeedRepositories,
): Promise<readonly string[]> {
  const [routeUsernames, diagnosticRecord] = await Promise.all([
    repositories.identityRoutes.listActiveSalesforceUsernames(),
    repositories.diagnostic.get(),
  ]);
  return Object.freeze([
    ...routeUsernames,
    ...(diagnosticRecord ? [diagnosticRecord.salesforceUsername] : []),
  ]);
}
