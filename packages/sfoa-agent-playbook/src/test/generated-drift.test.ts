import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      for (const file of ['docs/agent/DIFY_AGENT_INSTRUCTION.md', 'docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md',
        '.codebuddy/skills/sfoa-salesforce-assistant/SKILL.md', '.codebuddy/skills/sfoa-salesforce-assistant/references/tool-workflows.md']) {
        const content = readFileSync(resolve(root, file), 'utf8');
        assert.match(content, /1\.5\.1/u);
        assert.match(content, /PLATFORM_IDENTITY_FALLBACK/u);
        assert.match(content, /ask once/u);
        assert.match(content, /optional and absent/u);
        assert.doesNotMatch(content, /Omit every field marked/u);
      }
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
