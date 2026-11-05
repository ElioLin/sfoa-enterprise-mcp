import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOrder, buildWorkspaces } from './build-workspaces.mjs';

test('dependency ordering includes transitive build dependencies and rejects cycles before execution', () => {
  const graph = {
    admin: { workspaceDependencies: ['server', 'control'] },
    server: { workspaceDependencies: ['control', 'playbook'] },
    control: { workspaceDependencies: ['identity'] },
    identity: { workspaceDependencies: [] },
    playbook: { workspaceDependencies: [] },
  };
  assert.deepEqual(buildOrder(graph), ['identity', 'control', 'playbook', 'server', 'admin']);
  graph.identity.workspaceDependencies = ['admin'];
  assert.throws(() => buildOrder(graph), /cycle/);
});

test('actual Yarn workspace dispatch builds dependencies first, reports no-script workspaces and propagates failure', async () => {
  assert.ok(process.env.npm_execpath, 'run with yarn test:build');
  const root = await mkdtemp(join(tmpdir(), 'sfoa-build-order-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/*'] }));
    const packages = [
      ['a-consumer', { dependencies: { producer: '1.0.0', empty: '1.0.0' }, scripts: { build: 'node build.cjs' } },
        "require('node:fs').readFileSync('../z-producer/built'); require('node:fs').writeFileSync('built', 'ok')"],
      ['z-producer', { name: 'producer', scripts: { build: 'node build.cjs' } }, "require('node:fs').writeFileSync('built', 'ok')"],
      ['empty', {}, ''],
    ];
    for (const [directory, fields, code] of packages) {
      const folder = join(root, 'packages', directory);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'package.json'), JSON.stringify({ name: directory, version: '1.0.0', ...fields }));
      await writeFile(join(folder, 'build.cjs'), code);
    }
    assert.equal(buildWorkspaces(root, process.env.npm_execpath), 0);
    assert.equal(await readFile(join(root, 'packages/a-consumer/built'), 'utf8'), 'ok');
    await rm(join(root, 'packages/a-consumer/built'));
    await writeFile(join(root, 'packages/z-producer/build.cjs'), 'process.exit(7)');
    assert.notEqual(buildWorkspaces(root, process.env.npm_execpath), 0);
    await assert.rejects(readFile(join(root, 'packages/a-consumer/built')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
