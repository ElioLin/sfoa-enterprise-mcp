import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_PLAYBOOK_VERSION } from '@sfoa/agent-playbook';

const PAGE = readFileSync(resolve(process.cwd(), 'src', 'pages', 'AgentIntegrationPage.tsx'), 'utf8');
const GENERATOR = readFileSync(resolve(process.cwd(), 'src', 'agent', 'instruction-generator.ts'), 'utf8');

describe('P6 Agent Integration Admin contract', () => {
  it('presents all canonical distribution surfaces and the Playbook version', () => {
    expect(AGENT_PLAYBOOK_VERSION).toBe('1.7.0');
    for (const label of ['MCP 接入', 'Agent Playbook', '小犇 / Dify', '企业微信 / WeCom', 'WorkBuddy', 'MCP 原生指引']) {
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
    // P8-05: the page description and distribution status now name the WeCom surface.
    expect(PAGE).toContain('企业微信角色设定');
    expect(PAGE).toContain('WeCom Role Setting');
  });

  it('keeps the four identity setup paths distinct and removes P5 stale setup copy', () => {
    expect(PAGE).toContain('CURRENT_USER_TOKEN');
    expect(PAGE).toContain('USER_BOUND_TOKEN');
    expect(PAGE).toContain('MCP_CLIENT_TOKEN + X-Platform-User-Id');
    expect(PAGE).toContain('四种身份来源不可混用');
    // WeCom is a fourth identity path via the WECOM_HEADER channel.
    expect(PAGE).toContain('WECOM_HEADER');
    expect(PAGE).toContain('X-WeCom-User-Id');
    expect(PAGE).toContain('MCP_PLATFORM_USER_REQUIRED');
    expect(PAGE).toContain('MCP_PLATFORM_IDENTITY_CONFLICT');
    expect(PAGE).not.toContain('Bearer <YOUR_MCP_CLIENT_TOKEN>');
    expect(PAGE).not.toContain("'配置 platformUserId。'");
    expect(PAGE).not.toContain("'配置 X-Platform-User-Id。'");
    expect(PAGE).not.toContain('三种身份来源不可混用');
  });

  it('adapts Admin runtime facts into the canonical package instead of duplicating rules', () => {
    expect(GENERATOR).toContain('createAgentCapabilities');
    expect(GENERATOR).toContain('renderDifyInstruction');
    // P8-05: WeCom role setting is delegated to @sfoa/agent-playbook, never re-authored.
    expect(GENERATOR).toContain('renderWeComRoleSetting');
    expect(GENERATOR).toContain('generateWeComRoleSetting');
    expect(GENERATOR).not.toContain('function createWorkflow');
    expect(GENERATOR).not.toContain('function updateWorkflow');
    expect(GENERATOR).not.toContain('MCP_DML_OUTCOME_UNKNOWN');
  });

  it('presents WeCom onboarding UX with copy affordances and the four-channel MCP overview', () => {
    // WeCom is the second MCP connection example (four channels in one overview).
    expect(PAGE).toContain('企业微信 / WeCom（WECOM_HEADER）');
    expect(PAGE).toContain('企业微信 / WeCom MCP 连接示例');
    // Onboarding cards and copy controls.
    expect(PAGE).toContain('推荐角色设定');
    expect(PAGE).toContain('复制角色设定');
    expect(PAGE).toContain('企业微信 / WeCom 推荐步骤');
    expect(PAGE).toContain('企业微信智能机器人');
    expect(PAGE).toContain('当前用户身份');
    expect(PAGE).toContain('Salesforce 权限');
    expect(PAGE).toContain('Identity Route');
    expect(PAGE).toContain('验收清单');
    // Enabled-state gating is derived from runtime identity-header config.
    expect(PAGE).toContain('wecomChannelEnabled');
    expect(PAGE).toContain('buildWeComConnectionExample');
  });

  it('models WeCom as the native MCP smart bot and keeps the acceptance list to real runtime facts', () => {
    // The default setup is 企业微信智能机器人 + 原生 MCP Plugin + 企业域名 with the
    // platform auto-injecting the current user (never a self-built backend/gateway to map).
    expect(PAGE).toContain('企业微信智能机器人 + 原生 MCP Plugin');
    expect(PAGE).toContain('MCP 插件');
    expect(PAGE).toContain('企业域名');
    expect(PAGE).toContain('自动注入');
    expect(PAGE).toContain('无需手工填写');
    expect(PAGE).toContain('不需要自建应用后端');
    // No "build a self-built app / trusted gateway" mandate and no per-session user mapping.
    expect(PAGE).not.toContain('必须创建自建应用后端');
    expect(PAGE).not.toContain('必须开发可信网关');
    expect(PAGE).not.toContain('网关按会话映射用户');
    // Acceptance claims only verifiable runtime facts — never that a single forged
    // X-WeCom-User-Id header is auto-detected and rejected.
    expect(PAGE).not.toContain('换成另一用户（伪造）：请求被拒');
    expect(PAGE).toContain('identitySource = WECOM_HEADER');
    expect(PAGE).toContain('MCP_PLATFORM_USER_REQUIRED');
    expect(PAGE).toContain('MCP_PLATFORM_IDENTITY_CONFLICT');
    expect(PAGE).toContain('MCP_IDENTITY_ROUTE_NOT_FOUND');
    expect(PAGE).toContain('MCP_IDENTITY_ROUTE_DISABLED');
  });
});
