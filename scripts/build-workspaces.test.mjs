import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { executeBuilds, loadBuildGraph, planBuilds } from './build-workspaces.mjs';

const workspace = (name, dependencies = [], build = 'original-build') => ({
  name, dependencies: new Set(dependencies), manifest: { scripts: build ? { build } : {} },
});
const names = (plan) => plan.map((entry) => entry.name);
const graph = (...entries) => new Map(entries.map((entry) => [entry.name, entry]));

test('all workspaces build after dependencies in a stable order independent of discovery order', () => {
  const entries = [workspace('web', ['api']), workspace('isolated'), workspace('api', ['core']), workspace('core')];
  assert.deepEqual(names(planBuilds(graph(...entries))), ['core', 'api', 'isolated', 'web']);
  assert.deepEqual(names(planBuilds(graph(...entries.reverse()))), ['core', 'api', 'isolated', 'web']);
});

test('a target includes its transitive closure exactly once and excludes unrelated packages', () => {
  const g = graph(workspace('api', ['core', 'identity']), workspace('core', ['identity']), workspace('identity'), workspace('other'));
  assert.deepEqual(names(planBuilds(g, ['api'])), ['identity', 'core', 'api']);
});

test('cycles identify the dependency chain before any build runs', () => {
  assert.throws(() => planBuilds(graph(workspace('api', ['core']), workspace('core', ['api']))), /api -> core -> api/u);
});

test('a missing target or prerequisite fails explicitly', () => {
  assert.throws(() => planBuilds(graph(workspace('api', ['missing']))), /Missing workspace: missing/u);
  assert.throws(() => planBuilds(new Map(), ['unknown']), /Missing workspace: unknown/u);
});

test('a workspace without a build is explicit and its dependants still run', async () => {
  const runs = [];
  await executeBuilds(planBuilds(graph(workspace('config', [], null), workspace('api', ['config']))), async (entry) => {
    runs.push(entry.name);
    return 0;
  });
  assert.deepEqual(runs, ['api']);
});

test('a real failing process preserves its exit code and prevents dependant builds', async () => {
  const runs = [];
  await assert.rejects(executeBuilds(planBuilds(graph(workspace('api', ['core']), workspace('core'))), async (entry) => {
    runs.push(entry.name);
    return spawnSync(process.execPath, ['-e', 'process.exit(37)']).status;
  }), (error) => error.exitCode === 37 && /core/u.test(error.message));
  assert.deepEqual(runs, ['core']);
});

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-build-'));
  try {
    const info = {};
    for (const name of ['api', 'core']) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, 'package.json'), JSON.stringify({ name, scripts: { build: 'wireit' } }));
      info[name] = { location: name, workspaceDependencies: [], mismatchedWorkspaceDependencies: [] };
    }
    await run(root, info);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Yarn decides local versus published resolution, including mismatched workspace versions', async () => {
  await fixture(async (root, info) => {
    info.api.mismatchedWorkspaceDependencies.push('core');
    await writeFile(path.join(root, 'api/package.json'), JSON.stringify({
      name: 'api', dependencies: { core: '0.9.8' }, scripts: { build: 'original-build' },
    }));
    assert.deepEqual(names(planBuilds(loadBuildGraph(root, info), ['api'])), ['api']);
    info.api.workspaceDependencies.push('core');
    assert.deepEqual(names(planBuilds(loadBuildGraph(root, info), ['api'])), ['core', 'api']);
  });
});

test('Wireit build prerequisites contribute to the same closure', async () => {
  await fixture(async (root, info) => {
    await writeFile(path.join(root, 'api/package.json'), JSON.stringify({
      name: 'api', scripts: { build: 'wireit' }, wireit: {
        build: { dependencies: ['compile'] }, compile: { dependencies: ['../core:build'] },
      },
    }));
    assert.deepEqual(names(planBuilds(loadBuildGraph(root, info), ['api'])), ['core', 'api']);
  });
});

test('missing cross-workspace Wireit prerequisites cannot silently disappear', async () => {
  await fixture(async (root, info) => {
    await writeFile(path.join(root, 'api/package.json'), JSON.stringify({
      name: 'api', wireit: { build: { dependencies: ['../missing:build'] } },
    }));
    assert.throws(() => loadBuildGraph(root, info), /missing Wireit dependency/u);
  });
});
