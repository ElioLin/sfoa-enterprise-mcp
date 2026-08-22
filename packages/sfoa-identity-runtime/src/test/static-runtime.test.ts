import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('P1 production source has no Salesforce CLI/Auth Cache, database, Redis, or child-process dependency', async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = (await listTypeScriptFiles(sourceRoot)).filter((file) => !file.includes(`${path.sep}test${path.sep}`));
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(source, /node:child_process/u);
  assert.doesNotMatch(source, /AuthInfo\.listAllAuthorizations/u);
  assert.doesNotMatch(source, /ConfigAggregator/u);
  assert.doesNotMatch(source, /\b(?:Prisma|Drizzle|Redis|PostgreSQL|MySQL)\b/u);
  assert.doesNotMatch(source, /spawn\s*\(\s*['"]sf['"]/u);
});

test('P1 package explicitly pins the verified Provider and SDK extension set', async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.equal(manifest.dependencies['@salesforce/mcp-provider-api'], '0.6.0');
  assert.equal(manifest.dependencies['@salesforce/mcp-provider-dx-core'], '0.10.0');
  assert.equal(manifest.dependencies['@salesforce/core'], '8.29.0');
  assert.equal(manifest.dependencies['@modelcontextprotocol/sdk'], '1.18.2');
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(entryPath)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(entryPath);
  }
  return files;
}
