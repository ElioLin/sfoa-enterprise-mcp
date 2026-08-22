import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('P3 Provider has no database, Redis, CLI, auth, bulk, upsert, or delete implementation', async () => {
  const packageRoot = path.resolve(process.cwd());
  const manifest: unknown = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert(isRecord(manifest) && isRecord(manifest.dependencies));
  assert.deepEqual(manifest.dependencies, {
    '@modelcontextprotocol/sdk': '1.18.2',
    '@salesforce/core': '8.29.0',
    '@salesforce/mcp-provider-api': '0.6.0',
    zod: '3.25.76',
  });

  const files = await listTypeScriptFiles(path.join(packageRoot, 'src'));
  const productionSource = (
    await Promise.all(
      files
        .filter((file) => !file.includes(`${path.sep}test${path.sep}`))
        .map((file) => readFile(file, 'utf8')),
    )
  ).join('\n');
  assert.doesNotMatch(productionSource, /node:child_process|AuthInfo|StateAggregator|new\s+Connection\s*\(/u);
  assert.doesNotMatch(productionSource, /\.(?:destroy|delete|undelete|upsert|bulk|request)\s*\(/u);
  assert.doesNotMatch(productionSource, /prisma|drizzle|mysql|postgres|redis|sequelize/iu);
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
