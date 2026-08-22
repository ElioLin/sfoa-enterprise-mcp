import { ReleaseState } from '@salesforce/mcp-provider-api';
import { formatRemoteRuntimeError, RemoteRuntimeError } from '../errors.js';
import {
  compareOfficialProviderInventory,
  inspectOfficialDxCoreInventory,
} from '../upstream-drift.js';

async function main(): Promise<void> {
  try {
    const inventory = await inspectOfficialDxCoreInventory();
    const comparison = compareOfficialProviderInventory(inventory);
    console.log(
      JSON.stringify(
        {
          gate: 'P2_UPSTREAM_COMPATIBILITY',
          status: comparison.status,
          provider: inventory.providerName,
          providerApiVersion: inventory.providerApiVersion,
          package: `${inventory.packageName}@${inventory.packageVersion}`,
          gaTools: inventory.tools
            .filter((tool) => tool.releaseState === ReleaseState.GA)
            .map((tool) => tool.name)
            .sort(),
          drift: comparison.drift,
        },
        undefined,
        2,
      ),
    );
    if (comparison.status === 'UPSTREAM_REVIEW_REQUIRED') process.exitCode = 1;
  } catch (error) {
    const runtimeError =
      error instanceof RemoteRuntimeError
        ? error
        : new RemoteRuntimeError(
            'MCP_PROVIDER_INITIALIZATION_FAILED',
            'The upstream compatibility gate could not inspect the official Provider.',
            { cause: error },
          );
    console.error(formatRemoteRuntimeError(runtimeError));
    process.exitCode = 1;
  }
}

await main();
