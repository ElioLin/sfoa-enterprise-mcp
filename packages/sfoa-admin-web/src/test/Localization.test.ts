import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_NAVIGATION } from '../components/AdminShell.js';
import { ADMIN_ANT_LOCALE, ADMIN_LOCALE_CODE, statusLabel } from '../localization.js';
import { AGENT_RECOGNIZED_TOOL_NAMES } from '@sfoa/agent-playbook';

describe('zh-CN Admin presentation contract', () => {
  it('keeps every navigation label in Simplified Chinese', () => {
    expect(ADMIN_NAVIGATION.map(({ key, label }) => [key, label])).toEqual([
      ['/dashboard', '运行概览'],
      ['/identity-routes', '用户身份路由'],
      ['/tool-governance', '工具治理'],
      ['/dml-policies', 'DML 操作策略'],
      ['/diagnostic', '系统诊断'],
      ['/audit', '调用审计'],
      ['/system', '系统状态'],
      ['/agent-integration', '智能体接入'],
    ]);
  });

  it('uses the official Ant Design zh-CN locale', () => {
    expect(ADMIN_LOCALE_CODE).toBe('zh-CN');
    expect(ADMIN_ANT_LOCALE.locale).toBe('zh-cn');
    expect(ADMIN_ANT_LOCALE.Pagination?.next_page).toBe('下一页');
    expect(ADMIN_ANT_LOCALE.Modal?.okText).toBe('确定');
  });

  it('maps stored status values without changing raw enums', () => {
    expect(statusLabel('ENABLED')).toBe('已启用');
    expect(statusLabel('DISABLED')).toBe('已停用');
    expect(statusLabel('PASS')).toBe('通过');
    expect(statusLabel('DOWN')).toBe('不可用');
    expect(statusLabel('NOT TESTED')).toBe('未测试');
    expect(statusLabel('DIAGNOSTIC')).toBe('诊断');
  });

  it('keeps all primary page titles Chinese while preserving professional Tool names', () => {
    const expectedTitles: Readonly<Record<string, string>> = {
      'LoginPage.tsx': '管理员登录',
      'DashboardPage.tsx': '运行概览',
      'IdentityRoutesPage.tsx': '用户身份路由',
      'ToolGovernancePage.tsx': '工具治理',
      'DmlPoliciesPage.tsx': 'DML 操作策略',
      'DiagnosticPage.tsx': '系统诊断',
      'AuditPage.tsx': '全链路审计工作台',
      'SystemPage.tsx': '系统状态',
      'AgentIntegrationPage.tsx': '智能体接入',
    };
    for (const [file, title] of Object.entries(expectedTitles)) {
      const source = readFileSync(resolve(process.cwd(), 'src', 'pages', file), 'utf8');
      expect(source, file).toContain(title);
    }
    expect(AGENT_RECOGNIZED_TOOL_NAMES).toEqual(expect.arrayContaining([
      'get_username',
      'run_soql_query',
      'create_record',
      'update_record',
      'get_record_action_context',
      'run_diagnostic_tooling_query',
      'get_metadata_component_context',
      'get_agent_playbook',
      'get_record_links',
    ]));
    const integrationPage = readFileSync(resolve(process.cwd(), 'src', 'pages', 'AgentIntegrationPage.tsx'), 'utf8');
    expect(integrationPage).toContain('小犇 / Dify');
    expect(integrationPage).toContain('MCP 原生指引');
    expect(integrationPage).not.toContain("'配置 X-Platform-User-Id。'");
  });
});
