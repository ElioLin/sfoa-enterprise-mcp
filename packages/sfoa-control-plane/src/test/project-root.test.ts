import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadControlPlaneConfig, resolveSfoaProjectRoot } from '../index.js';

test('Admin API and MCP resolve the same root .env.local from every supported cwd', async (context) => {
  const originalCwd = process.cwd();
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-project-root-'));
  const adminPackage = path.join(projectRoot, 'packages', 'sfoa-admin-api');
  const mcpPackage = path.join(projectRoot, 'packages', 'sfoa-mcp-server');
  await Promise.all([
    mkdir(path.join(adminPackage, 'dist'), { recursive: true }),
    mkdir(path.join(mcpPackage, 'dist'), { recursive: true }),
    writeFile(path.join(projectRoot, '.env.local'), [
      'SFOA_CONTROL_PLANE_MODE=mysql',
      'SFOA_DB_HOST=127.0.0.1',
      'SFOA_DB_NAME=sfoa_root_resolution_test',
      'SFOA_DB_USER=sfoa_root_test',
      'SFOA_DB_PASSWORD=root-test-only',
    ].join('\n'), 'utf8'),
  ]);
  context.after(async () => {
    process.chdir(originalCwd);
    await rm(projectRoot, { recursive: true, force: true });
  });

  const adminModuleUrl = pathToFileURL(path.join(adminPackage, 'dist', 'main.js'));
  const mcpModuleUrl = pathToFileURL(path.join(mcpPackage, 'dist', 'main.js'));
  const cases = [projectRoot, mcpPackage, adminPackage];
  for (const cwd of cases) {
    process.chdir(cwd);
    assert.equal(resolveSfoaProjectRoot(adminModuleUrl), projectRoot);
    assert.equal(resolveSfoaProjectRoot(mcpModuleUrl), projectRoot);
  }

  process.chdir(adminPackage);
  const adminConfig = await loadControlPlaneConfig(resolveSfoaProjectRoot(adminModuleUrl), {});
  process.chdir(mcpPackage);
  const mcpConfig = await loadControlPlaneConfig(resolveSfoaProjectRoot(mcpModuleUrl), {});
  assert.deepEqual(adminConfig, mcpConfig);
  assert.equal(adminConfig.database?.database, 'sfoa_root_resolution_test');
});

test('project root resolution fails closed outside the packages layout', () => {
  assert.throws(
    () => resolveSfoaProjectRoot(pathToFileURL(path.join(tmpdir(), 'standalone', 'main.js'))),
    /module is not below packages/u,
  );
});
