import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(process.cwd(), '..', '..', '.codebuddy', 'skills', 'sfoa-salesforce-assistant');

describe('WorkBuddy / CodeBuddy Skill content', () => {
  it('has valid required YAML frontmatter and progressive-disclosure references', async () => {
    const skill = await readFile(resolve(SKILL_ROOT, 'SKILL.md'), 'utf8');
    const workflows = await readFile(resolve(SKILL_ROOT, 'references', 'tool-workflows.md'), 'utf8');
    const safety = await readFile(resolve(SKILL_ROOT, 'references', 'safety-boundaries.md'), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(skill)?.[1];

    expect(frontmatter).toBeDefined();
    expect(frontmatter).toMatch(/^name:\s+sfoa-salesforce-assistant$/mu);
    expect(frontmatter).toMatch(/^description:\s*>$/mu);
    expect(frontmatter).not.toMatch(/^allowed-tools:/mu);
    expect(skill).toContain('[references/tool-workflows.md](references/tool-workflows.md)');
    expect(skill).toContain('[references/safety-boundaries.md](references/safety-boundaries.md)');
    expect(skill).toContain('GENERATED FROM SFoA Agent Playbook (@sfoa/agent-playbook) 1.0.0');
    expect(skill).toContain('Bearer <USER_BOUND_TOKEN>');
    expect(skill).toContain('Do not configure `X-Platform-User-Id`');

    const completeSkill = `${skill}\n${workflows}\n${safety}`;
    for (const required of [
      '## READ', '## CREATE', '## UPDATE', '## DIAGNOSIS', '## PICKLIST', '## LOOKUP',
      'trusted Lightning record link', 'MCP_DML_OUTCOME_UNKNOWN', 'get_record_action_context',
      'create_record', 'update_record', 'get_record_links',
    ]) {
      expect(completeSkill).toContain(required);
    }
  });
});
