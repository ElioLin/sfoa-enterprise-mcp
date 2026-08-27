import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_PLAYBOOK_VERSION } from '@sfoa/agent-playbook';

const PAGE = readFileSync(resolve(process.cwd(), 'src', 'pages', 'AgentIntegrationPage.tsx'), 'utf8');
const GENERATOR = readFileSync(resolve(process.cwd(), 'src', 'agent', 'instruction-generator.ts'), 'utf8');

describe('P6 Agent Integration Admin contract', () => {
  it('presents all canonical distribution surfaces and the Playbook version', () => {
    expect(AGENT_PLAYBOOK_VERSION).toBe('1.1.0');
    for (const label of ['MCP 接入', 'Agent Playbook', '小犇 / Dify', 'WorkBuddy', 'MCP 原生指引']) {
      expect(PAGE).toContain(label);
    }
    for (const surface of [
      'sfoa://agent-playbook/current',
      'sfoa://agent-capabilities/current',
      'sfoa_salesforce_assistant',
      'get_agent_playbook',
      'get_record_links',
    ]) {
      expect(PAGE).toContain(surface);
    }
    expect(PAGE).toContain('Dynamic Forms evidence');
    expect(PAGE).toContain('yarn agent:check');
    expect(PAGE).toContain('查看完整规范');
    expect(PAGE).toContain('label="SYNCED"');
    expect(PAGE).toContain('label="GENERATED"');
  });

  it('keeps the three identity setup paths distinct and removes P5 stale setup copy', () => {
    expect(PAGE).toContain('CURRENT_USER_TOKEN');
    expect(PAGE).toContain('USER_BOUND_TOKEN');
    expect(PAGE).toContain('MCP_CLIENT_TOKEN + X-Platform-User-Id');
    expect(PAGE).not.toContain('Bearer <YOUR_MCP_CLIENT_TOKEN>');
    expect(PAGE).not.toContain("'配置 platformUserId。'");
    expect(PAGE).not.toContain("'配置 X-Platform-User-Id。'");
  });

  it('adapts Admin runtime facts into the canonical package instead of duplicating rules', () => {
    expect(GENERATOR).toContain('createAgentCapabilities');
    expect(GENERATOR).toContain('renderDifyInstruction');
    expect(GENERATOR).not.toContain('function createWorkflow');
    expect(GENERATOR).not.toContain('function updateWorkflow');
    expect(GENERATOR).not.toContain('MCP_DML_OUTCOME_UNKNOWN');
  });
});
