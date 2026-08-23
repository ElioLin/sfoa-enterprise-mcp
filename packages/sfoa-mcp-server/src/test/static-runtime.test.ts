import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('official pins remain exact while P3/P4 add only SFoA Provider dependencies', async () => {
  const packageRoot = path.resolve(process.cwd());
  const manifestText = await readFile(path.join(packageRoot, 'package.json'), 'utf8');
  const manifest: unknown = JSON.parse(manifestText);
  assert(isRecord(manifest) && isRecord(manifest.dependencies));
  assert.equal(manifest.dependencies['@modelcontextprotocol/sdk'], '1.18.2');
  assert.equal(manifest.dependencies['@salesforce/mcp-provider-api'], '0.6.0');
  assert.equal(manifest.dependencies['@salesforce/mcp-provider-dx-core'], '0.10.0');
  assert.equal(manifest.dependencies['@salesforce/core'], '8.29.0');
  assert.equal(manifest.dependencies.zod, '3.25.76');
  assert.equal(manifest.dependencies['@sfoa/identity-runtime'], '0.1.0-p4');
  assert.equal(manifest.dependencies['@sfoa/mcp-provider-sfoa-context'], '0.1.0-p4');
  assert.equal(manifest.dependencies['@sfoa/mcp-provider-sfoa-dml'], '0.1.0-p3');
  for (const forbidden of ['prisma', 'drizzle', 'mysql', 'pg', 'redis', 'sequelize']) {
    assert.equal(forbidden in manifest.dependencies, false);
  }

  const productionFiles = await listTypeScriptFiles(path.join(packageRoot, 'src'));
  const productionSource = (
    await Promise.all(
      productionFiles
        .filter((file) => !file.includes(`${path.sep}test${path.sep}`) && !file.includes(`${path.sep}validation${path.sep}`))
        .map((file) => readFile(file, 'utf8')),
    )
  ).join('\n');
  assert.doesNotMatch(productionSource, /node:child_process|AuthInfo\.listAllAuthorizations|StateAggregator/u);
  assert.doesNotMatch(productionSource, /create_sobject|update_sobject|delete_sobject/u);
  assert.doesNotMatch(
    productionSource,
    /@salesforce\/mcp-provider-code-analyzer|\bnew\s+CodeAnalyzerMcpProvider|node:child_process|\b(?:redis|prisma|sequelize)\b/iu,
  );
  assert.doesNotMatch(productionSource, /MCP_CLIENT_TOKEN.*(?:log|write)|authorization.*(?:log|write)/iu);
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(target)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(target);
  }
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
