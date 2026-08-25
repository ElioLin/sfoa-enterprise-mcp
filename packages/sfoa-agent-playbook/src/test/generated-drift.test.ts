import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/sync-generated.mjs');

describe('generated Agent artifact drift guard', () => {
  it('passes after sync and fails after an intentional edit', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sfoa-agent-playbook-'));
    try {
      assert.equal(run('--write', root).status, 0);
      assert.equal(run('--check', root).status, 0);
      appendFileSync(resolve(root, 'docs/agent/DIFY_AGENT_INSTRUCTION.md'), '\nmanual drift\n', 'utf8');
      const drift = run('--check', root);
      assert.equal(drift.status, 1);
      assert.match(String(drift.stderr), /DIFY_AGENT_INSTRUCTION\.md/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function run(mode: '--write' | '--check', root: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT, mode, '--root', root], { encoding: 'utf8' });
}
